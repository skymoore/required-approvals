const core = require('@actions/core');
const github = require('@actions/github');

(async () => {
  try {
    const token = core.getInput('token');
    const minApprovals = parseInt(core.getInput('min_approvals'), 10);

    const octokit = github.getOctokit(token);
    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const prNumber = context.issue.number;

    async function isApprovedByCodeowners() {
      // Get PR information
      const prData = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      });

      // Get the list of codeowners from the CODEOWNERS file
      const codeownersContent = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: '.github/CODEOWNERS',
        ref: prData.data.base.ref
      });

      const codeowners = Buffer.from(codeownersContent.data.content, 'base64').toString('utf8');
      const codeownerUsernames = codeowners.split('\n').map(line => line.split(' ')[1].substring(1));
      console.log(`Codeowners: ${codeownerUsernames}`);

      // Get PR reviews
      const reviews = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber
      });

      // Check if all codeowners have approved
      const approvedCodeowners = reviews.data
        .filter(review => review.state === 'APPROVED')
        .map(review => review.user.login);

      const allCodeownersApproved = codeownerUsernames.every(username => approvedCodeowners.includes(username));
      console.log(`All Codeowners Approved: ${allCodeownersApproved}`);

      // Check minimum approvals
      const totalApprovals = approvedCodeowners.length;
      console.log(`Total approvals: ${totalApprovals}`);
      const minApprovalsMet = totalApprovals >= minApprovals;
      console.log(`Minimum approvals met: ${minApprovalsMet}`);

      return allCodeownersApproved && minApprovalsMet;
    }

    const approved = await isApprovedByCodeowners();
    core.setOutput('approved', approved);
  } catch (error) {
    core.setFailed(error.message);
  }
})();
