#!/usr/bin/env python3

import os
from github import Github

def main():
    token = os.environ["INPUT_TOKEN"]
    min_approvals = int(os.environ["INPUT_MIN_APPROVALS"])
    
    g = Github(token)
    repo = g.get_repo(os.environ["GITHUB_REPOSITORY"])
    pr_number = int(os.environ["GITHUB_REF"].split('/')[-1])
    
    pr = repo.get_pull(pr_number)
    reviews = pr.get_reviews()

    approved_codeowners = [r.user.login for r in reviews if r.state == "APPROVED"]
    
    codeowners_content = repo.get_contents(".github/CODEOWNERS", ref=pr.base.ref)
    codeowners_rules = codeowners_content.decoded_content.decode('utf-8').split('\n')
    
    required_codeowners = []
    for rule in codeowners_rules:
        if rule.strip() and ' ' in rule:
            path, *usernames = rule.split(' ')
            required_codeowners.extend(u[1:] for u in usernames)
    
    all_codeowners_approved = all(u in approved_codeowners for u in required_codeowners)
    min_approvals_met = len(approved_codeowners) >= min_approvals
    
    os.environ["OUTPUT_APPROVED"] = str(all_codeowners_approved and min_approvals_met).lower()

if __name__ == "__main__":
    main()
