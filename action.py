#!/usr/bin/env python3

import os, logging
from github import Github


def get_required_codeowners(repo, pr, directory):

    codeowners_content = repo.get_contents(".github/CODEOWNERS", ref=pr.base.ref)
    logging.info(f"Codeowners content:\n{codeowners_content.decoded_content.decode('utf-8')}")
    codeowners_rules = codeowners_content.decoded_content.decode('utf-8').split('\n')
    logging.info(f"Codeowners rules:\n{codeowners_rules}")

    required_codeowner_teams = {}
    for line in codeowners_rules:
        logging.info(f"Checking line: {line}")
        if line.startswith(directory) or line.startswith(f"/{directory}"):
            logging.info(f"Found {directory} in {line}")
            line_list = line.split()
            line_list.pop(0)
            for team in line_list:
                logging.info(f"Found team: {team} (required)")
                required_codeowner_teams[team] = False

    logging.info(f"Required codeowners: {required_codeowner_teams}")
    return required_codeowner_teams 

def get_user_teams(gh, username, org_name):
    logging.info(f"Getting teams for {username}")
    user = gh.get_user(username)
    org = gh.get_organization(org_name)
    org_teams = org.get_teams()
    logging.info(f"Found teams for {org.login}: {list(org_teams)}")
    teams = []

    for team in org_teams:
        org_team_members = [member.login for member in team.get_members()]
        logging.info(f"Found members for {org.login}/{team.name}: {list(org_team_members)}")
        if user.login in org_team_members:
            teams.append((org.login, team.name))

    return teams

def main():
    token = os.environ["INPUT_TOKEN"]
    read_org_token = os.environ["INPUT_READ_ORG_SCOPED_TOKEN"]
    org_name = os.environ["INPUT_ORG_NAME"]
    min_approvals = int(os.environ["INPUT_MIN_APPROVALS"])
    gh_ref = os.environ["GITHUB_REF"]
    gh_repo = os.environ["GITHUB_REPOSITORY"]
    
    gh = Github(token)
    gh_org = Github(read_org_token)
    repo = gh.get_repo(gh_repo)
    logging.info(gh_ref)
    gh_ref_parts = gh_ref.split('/')
    logging.info(gh_ref_parts)
    pr_number = int(gh_ref_parts[-2])
    
    pr = repo.get_pull(pr_number)
    reviews = pr.get_reviews()

    changed_files = [f.filename for f in pr.get_files()]
    changed_dirs = set([os.path.dirname(f).split("/")[0] for f in changed_files])
    logging.info(f"Changed files: {changed_files}")
    logging.info(f"Changed dirs: {changed_dirs}")

    required_codeowner_teams = {}
    for dir in changed_dirs:
        required_codeowner_teams.update(get_required_codeowners(repo, pr, dir))
    logging.info(f"Required codeowners: {required_codeowner_teams}")

    reviews = list(reviews)
    logging.info(f"Found {len(reviews)} reviews for PR {pr_number} ({pr.title}):")
    approved_codeowners = []
    for review in reviews:
        logging.info("Review: " + str(review))
        user_teams = get_user_teams(gh_org, review.user.login, org_name)
        logging.info(f"  {review.user.login} {review.state}: teams: {user_teams}")

        if review.state == "APPROVED":
            for team in user_teams:
                if team.name in required_codeowner_teams:
                    required_codeowner_teams[team.name] = True
                    approved_codeowners.append(review.user.login)

        elif review.state == "CHANGES_REQUESTED":
            for team in user_teams:
                if team.name in required_codeowner_teams:
                    required_codeowner_teams[team.name] = False

        else:
            logging.info(f"  {review.user.login} {review.state}: ignoring")
    
    logging.info(f"Required codeowners: {required_codeowner_teams}")
    
    all_codeowners_approved = all(required_codeowner_teams.values())
    min_approvals_met = len(approved_codeowners) >= min_approvals

    required_approvals = (all_codeowners_approved and min_approvals_met)
    
    os.environ["OUTPUT_APPROVED"] = str(required_approvals).lower()

    if required_approvals:
        logging.info(f"Required approvals met: {required_codeowner_teams}")
        exit(0)
    else:
        logging.info(f"Required approvals not met: {required_codeowner_teams}")
        exit(1)

if __name__ == "__main__":
    log_level = os.environ.get("DEBUG_LOGGING", "0")
    logging.basicConfig(
        level=logging.info if log_level == "1" else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    main()
