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
      console.log(`Codeowners file content: ${codeowners}`)

      const codeownerRules = codeowners.split('\n')
        .filter(line => line.trim() && line.includes(' '))
        .map(line => {
          const [path, ...usernames] = line.split(' ');
          return {
            path,
            usernames: usernames.map(username => username.substring(1))
          };
        });

      // Get PR file changes
      const changedFiles = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber
      });

      const changedDirectories = changedFiles.data.map(file => {
        const filePathParts = file.filename.split('/');
        filePathParts.pop();
        return filePathParts.join('/') + '/';
      });

      const requiredCodeowners = [];
      for (const dir of changedDirectories) {
        for (const rule of codeownerRules) {
          if (dir.startsWith(rule.path)) {
            requiredCodeowners.push(...rule.usernames);
            break;
          }
        }
      }

      const uniqueCodeowners = [...new Set(requiredCodeowners)];
      console.log(`Codeowners: ${uniqueCodeowners}`);

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

      const allCodeownersApproved = uniqueCodeowners.every(username => approvedCodeowners.includes(username));
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
