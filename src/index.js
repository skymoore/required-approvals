const { Octokit } = require("@octokit/rest");
const minimatch = require("minimatch").minimatch;
const process = require("process");
const path = require("path");
const fs = require("fs");

async function getNewestPRNumberByBranch(octokit, branchName, repo) {
    const { data: pullRequests } = await octokit.pulls.list({
        owner: repo.owner.login,
        repo: repo.name,
        state: "all",
        head: `${repo.owner.login}:${branchName}`,
    });

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

        const [pattern, ...owners] = line.trim().split(/\s+/);

        if (pattern === '*') {
            updateCodeowners(owners);
        } else {
            for (const changedFile of changedFiles) {
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
        const { data: teamMembers } = await octokit.teams.listMembersInOrg({
            org: orgName,
            team_slug: team.slug,
        });

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

    const octokit = new Octokit({ auth: token });
    const readOrgOctokit = new Octokit({ auth: readOrgToken });

    const [owner, repoName] = ghRepo.split("/");
    const repo = await octokit.repos.get({ owner, repo: repoName });

    const { data: orgTeams } = await readOrgOctokit.teams.list({ org: orgName });

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

    const { data: reviews } = await octokit.pulls.listReviews({
        owner: repo.data.owner.login,
        repo: repo.data.name,
        pull_number: pr.number,
    });

    const changedFiles = (await octokit.pulls.listFiles({
        owner: repo.data.owner.login,
        repo: repo.data.name,
        pull_number: pr.number,
    })).data.map((f) => f.filename);

    const requiredCodeownerEntities = await getRequiredCodeowners(changedFiles, repo.data, pr, octokit);
    console.info(`Required codeowners: ${JSON.stringify(requiredCodeownerEntities)}`);

    const approvedCodeowners = [];

    for (const review of reviews) {
        const userTeams = await getUserTeams(review.user.login, orgName, orgTeams, readOrgOctokit);
        const reviewerLogin = review.user.login.toLowerCase();

        if (review.state === "APPROVED") {
            for (const team of userTeams) {
                const teamName = team.name.toLowerCase().replace(/ /g, "-");
                if (requiredCodeownerEntities.hasOwnProperty(teamName)) {
                    if (
                        requireAllApprovalsLatestCommit === "true" &&
                        review.commit_id !== pr.head.sha
                    ) {
                        console.info(
                            `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id} for: ${team.name} (not the latest commit, ignoring)`
                        );
                        continue;
                    }
                    requiredCodeownerEntities[teamName] = true;
                    if (!approvedCodeowners.includes(review.user.login)) {
                        approvedCodeowners.push(review.user.login);
                    }
                    console.info(
                        `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id} for: ${team.name}`
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
                const teamName = team.name.toLowerCase();
                if (requiredCodeownerEntities.hasOwnProperty(teamName)) {
                    requiredCodeownerEntities[teamName] = false;
                    console.info(`  ${reviewerLogin} ${review.state}: for: ${team.name}`);
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
    const minApprovalsMet = new Set(approvedCodeowners).size >= minApprovals;

    const coReason = allCodeownersApproved ? "all codeowners approved" : "not all codeowners approved";
    const maReason = minApprovalsMet
        ? `total approvals:${approvedCodeowners.length} >= minimum approvals:${minApprovals}`
        : `total approvals:${approvedCodeowners.length} < minimum approvals:${minApprovals}`;
    const reason = `${coReason} and ${maReason}`;

    const requiredApprovals = allCodeownersApproved && minApprovalsMet;

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

