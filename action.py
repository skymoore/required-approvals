#!/usr/bin/env python3

import os
from github import Github

def get_required_codeowners(repo, pr, directory):

    codeowners_content = repo.get_contents(".github/CODEOWNERS", ref=pr.base.ref)
    codeowners_rules = codeowners_content.decoded_content.decode('utf-8').split('\n')

    required_codeowner_teams = {}
    for line in codeowners_rules:
        if line.startswith(directory):
            line_list = line.split()
            line_list.pop(0)
            for team in line_list:
                required_codeowner_teams[team] = False

    return required_codeowner_teams 

def main():
    token = os.environ["INPUT_TOKEN"]
    min_approvals = int(os.environ["INPUT_MIN_APPROVALS"])
    gh_ref = os.environ["GITHUB_REF"]
    gh_repo = os.environ["GITHUB_REPOSITORY"]
    
    g = Github(token)
    repo = g.get_repo(gh_repo)
    pr_number = int(gh_ref.split('/')[-1])
    
    pr = repo.get_pull(pr_number)
    reviews = pr.get_reviews()

    changed_files = [f.filename for f in pr.get_files()]
    changed_dirs = set([os.path.dirname(f) for f in changed_files])

    required_codeowner_teams = {}
    for dir in changed_dirs:
        required_codeowner_teams.update(get_required_codeowners(repo, pr, dir))

    print(f"Found {len(reviews)} reviews for PR {pr_number} ({pr.title}):")
    approved_codeowners = []
    for r in reviews:
        user_teams = [t for t in r.user.get_teams()]
        print(f"  {r.user.login} {r.state}: teams: {user_teams}")
        if r.state == "APPROVED":
            for team in user_teams:
                if team.name in required_codeowner_teams:
                    required_codeowner_teams[team.name] = True
                    approved_codeowners.append(r.user.login)
        elif r.state == "CHANGES_REQUESTED":
            for team in user_teams:
                if team.name in required_codeowner_teams:
                    required_codeowner_teams[team.name] = False
        else:
            print(f"  {r.user.login} {r.state}: ignoring")
    
    print(f"Required codeowners: {required_codeowner_teams}")
    
    all_codeowners_approved = all(required_codeowner_teams.values())
    min_approvals_met = len(approved_codeowners) >= min_approvals
    
    os.environ["OUTPUT_APPROVED"] = str(all_codeowners_approved and min_approvals_met).lower()

if __name__ == "__main__":
    main()
