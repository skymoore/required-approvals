const { Octokit } = require("@octokit/rest");
const minimatch = require("minimatch").minimatch;
const process = require("process");
const path = require("path");
const fs = require("fs");

async function getNewestPRNumberByBranch(octokit, branchName, repo) {
    const pullRequests = await octokit.paginate(
        octokit.pulls.list,
        {
            owner: repo.owner.login,
            repo: repo.name,
            state: "all",
            head: `${repo.owner.login}:${branchName}`,
        },
        (response) => response.data
    );

    if (pullRequests.length === 0) {
        console.info(`No PRs found for branch ${branchName}`);
        process.exit(1);
    }

    pullRequests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const newestPR = pullRequests[0].number;
    return newestPR;
}

async function getRequiredCodeowners(changedFiles, repo, pr, octokit) {
    const codeownersContent =
        (await getContent(octokit, repo, ".github/CODEOWNERS", pr.base.ref)) ||
        (await getContent(octokit, repo, "CODEOWNERS", pr.base.ref));

    if (!codeownersContent) {
        console.info("No CODEOWNERS file found");
        process.exit(1);
    }

    const codeownersLines = codeownersContent.split("\n");

    const codeowners = {};
    for (const line of codeownersLines) {
        if (!line.trim() || line.startsWith("#")) {
            continue;
        }

        let [pattern, ...owners] = line.trim().split(/\s+/);

        if (pattern === '*') {
            updateCodeowners(owners);
        } else {
            if (!pattern.startsWith('/')) {
                pattern = `**/${pattern}`;
            }
            for (let changedFile of changedFiles) {
                changedFile = `/${changedFile}`;
                if (minimatch(changedFile, pattern)) {
                    updateCodeowners(owners);
                }
            }
        }
    }

    return codeowners;

    function updateCodeowners(owners) {
        for (let owner of owners) {
            owner = owner.replace(/[<>\(\)\[\]\{\},;+*?=]/g, "");
            owner = owner.replace("@", "").split("/").pop();
            owner = owner.toLowerCase();
            if (!codeowners.hasOwnProperty(owner)) {
                codeowners[owner] = false;
            }
        }
    }
}

async function getUserTeams(username, orgName, orgTeams, octokit) {
    const teams = [];

    for (const team of orgTeams) {
        const teamMembers = await octokit.paginate(
            octokit.teams.listMembersInOrg,
            {
                org: orgName,
                team_slug: team.slug,
            },
            (response) => response.data
        );

        const memberLogins = teamMembers.map((member) => member.login);
        if (memberLogins.includes(username)) {
            teams.push(team);
        }
    }

    return teams;
}

async function getContent(octokit, repo, path, ref) {
    try {
        const { data } = await octokit.repos.getContent({
            owner: repo.owner.login,
            repo: repo.name,
            path,
            ref,
        });
        return Buffer.from(data.content, "base64").toString();
    } catch (error) {
        if (error.status === 404) {
            return null;
        }
        throw error;
    }
}

async function main() {
    const token = process.env["INPUT_TOKEN"];
    const readOrgToken = process.env["INPUT_READ_ORG_SCOPED_TOKEN"];
    const orgName = process.env["INPUT_ORG_NAME"];
    const minApprovals = parseInt(process.env["INPUT_MIN_APPROVALS"], 10);
    const requireAllApprovalsLatestCommit =
        process.env["INPUT_REQUIRE_ALL_APPROVALS_LATEST_COMMIT"];
    const ghRef = process.env["GITHUB_REF"];
    const ghRepo = process.env["GITHUB_REPOSITORY"];
    const approvalMode = process.env["INPUT_APPROVAL_MODE"];

    const octokit = new Octokit({ auth: token });
    const readOrgOctokit = new Octokit({ auth: readOrgToken });

    const [owner, repoName] = ghRepo.split("/");
    const repo = await octokit.repos.get({ owner, repo: repoName });

    const allOrgTeams = await readOrgOctokit.paginate(
        readOrgOctokit.teams.list,
        { org: orgName },
        (response) => response.data
    );

    let prNumber;
    if (process.env["INPUT_BRANCH"] && process.env["INPUT_BRANCH"] !== "") {
        prNumber = await getNewestPRNumberByBranch(octokit, process.env["INPUT_BRANCH"], repo.data);
    } else if (process.env["INPUT_PR_NUMBER"] && process.env["INPUT_PR_NUMBER"] !== "") {
        prNumber = parseInt(process.env["INPUT_PR_NUMBER"], 10);
    } else {
        const ghRefParts = ghRef.split("/");
        prNumber = parseInt(ghRefParts[ghRefParts.length - 2], 10);
    }

    const { data: pr } = await octokit.pulls.get({
        owner: repo.data.owner.login,
        repo: repo.data.name,
        pull_number: prNumber,
    });

    const reviews = await octokit.paginate(
        octokit.pulls.listReviews,
        {
            owner: repo.data.owner.login,
            repo: repo.data.name,
            pull_number: pr.number,
        },
        (response) => response.data
    );

    const changedFiles = await octokit.paginate(
        octokit.pulls.listFiles,
        {
            owner: repo.data.owner.login,
            repo: repo.data.name,
            pull_number: pr.number
        },
        (response) => response.data.map((f) => f.filename)
    );

    const requiredCodeownerEntities = await getRequiredCodeowners(changedFiles, repo.data, pr, octokit);
    console.info(`Required codeowners: ${Object.keys(requiredCodeownerEntities).join(', ')}`);

    const orgTeams = [];

    if (process.env["INPUT_LIMIT_ORG_TEAMS_TO_CODEOWNERS_FILE"] === "true") {
        const requiredCodeownerEntitySlugs = new Set(Object.keys(requiredCodeownerEntities));
        const filteredTeams = allOrgTeams.filter((team) => {
            return requiredCodeownerEntitySlugs.has(team.slug);
        });

        if (filteredTeams.length !== requiredCodeownerEntitySlugs.size) {
            for (const slug of requiredCodeownerEntitySlugs) {
                if (!filteredTeams.some((team) => team.slug === slug)) {
                    console.warn(`  Team: ${slug} not found in Org: ${orgName}`);
                }
            }
        }
        orgTeams.push(...filteredTeams);
    } else {
        orgTeams = allOrgTeams;
    }

    const approvedCodeowners = [];

    for (const review of reviews) {
        const userTeams = await getUserTeams(review.user.login, orgName, orgTeams, readOrgOctokit);
        const reviewerLogin = review.user.login.toLowerCase();

        if (review.state === "APPROVED") {
            for (const team of userTeams) {
                if (requiredCodeownerEntities.hasOwnProperty(team.slug)) {
                    if (
                        requireAllApprovalsLatestCommit === "true" &&
                        review.commit_id !== pr.head.sha
                    ) {
                        console.info(
                            `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id} for: ${team.slug} (not the latest commit, ignoring)`
                        );
                        continue;
                    }
                    requiredCodeownerEntities[team.slug] = true;
                    if (!approvedCodeowners.includes(review.user.login)) {
                        approvedCodeowners.push(review.user.login);
                    }
                    console.info(
                        `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id} for: ${team.slug}`
                    );
                }
            }

            if (requiredCodeownerEntities.hasOwnProperty(reviewerLogin)) {
                requiredCodeownerEntities[reviewerLogin] = true;
                console.info(
                    `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id}`
                );
            }
        } else if (review.state === "CHANGES_REQUESTED") {
            for (const team of userTeams) {
                if (requiredCodeownerEntities.hasOwnProperty(team.slug)) {
                    requiredCodeownerEntities[team.slug] = false;
                    console.info(`  ${reviewerLogin} ${review.state}: for: ${team.slug}`);
                }
            }
            if (requiredCodeownerEntities.hasOwnProperty(reviewerLogin)) {
                requiredCodeownerEntities[reviewerLogin] = false;
                console.info(`  ${reviewerLogin} ${review.state}: for: ${reviewerLogin}`);
            }
        } else {
            console.debug(`  ${reviewerLogin} ${review.state}: ignoring`);
        }
    }

    const allCodeownersApproved = Object.values(requiredCodeownerEntities).every((value) => value);
    const anyCodeownerApproved = Object.values(requiredCodeownerEntities).some((value) => value);

    const codeownersApprovalsCheck = approvalMode === "ANY" ? anyCodeownerApproved : allCodeownersApproved;
    const minApprovalsMet = new Set(approvedCodeowners).size >= minApprovals;

    let coReason;
    if (approvalMode === "ALL") {
        coReason = allCodeownersApproved ? "All codeowners have approved." : "Not all codeowners have approved.";
    } else if (approvalMode === "ANY") {
        coReason = anyCodeownerApproved ? "At least one of the codeowners has approved." : "None of the codeowners has approved.";
    }

    const maReason = minApprovalsMet
        ? `total approvals:${approvedCodeowners.length} >= minimum approvals:${minApprovals}`
        : `total approvals:${approvedCodeowners.length} < minimum approvals:${minApprovals}`;
    const reason = `${coReason} and ${maReason}`;

    const requiredApprovals = codeownersApprovalsCheck && minApprovalsMet;

    const outputPath = process.env["GITHUB_OUTPUT"];
    fs.appendFileSync(outputPath, `approved=${requiredApprovals.toString().toLowerCase()}`);

    if (requiredApprovals) {
        console.info(`Required approvals met: ${reason}`);
        process.exit(0);
    } else {
        console.warn(`Required approvals not met: ${reason}`);
        process.exit(1);
    }

}

main();
