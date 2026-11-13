"""One-time Google login. Run it once, click Allow, and it saves secrets/google_token.json.

    uv run --with google-auth-oauthlib python google_auth.py

(Testing-mode Google apps expire the login after 7 days. Just run this again.)
"""
import json
import os
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",  # create/delete events, Meet links
    "https://www.googleapis.com/auth/tasks",            # checklist
    "https://www.googleapis.com/auth/gmail.modify",     # read mail, create drafts
    "https://www.googleapis.com/auth/gmail.send",       # send replies
]

HERE = os.path.dirname(os.path.abspath(__file__))
SECRETS = os.path.join(HERE, "secrets")
CREDS = os.path.join(SECRETS, "google_credentials.json")
TOKEN = os.path.join(SECRETS, "google_token.json")


def main():
    if not os.path.exists(CREDS):
        sys.exit(f"Missing {CREDS}. Download the Desktop-app OAuth JSON from Google Cloud Console.")
    flow = InstalledAppFlow.from_client_secrets_file(CREDS, SCOPES)
    # prompt=consent + offline makes sure Google returns a refresh token
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    if not creds.refresh_token:
        sys.exit("Google did not return a refresh token. Remove the app at "
                 "myaccount.google.com/permissions and run this again.")
    with open(TOKEN, "w", encoding="utf-8") as f:
        json.dump({
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "scopes": list(creds.scopes or SCOPES),
        }, f, indent=2)
    print(f"Done. Saved {TOKEN}")


if __name__ == "__main__":
    main()
