"""Admin commands.

    python -m app.cli create-owner email@example.com   prompts for a password
    python -m app.cli ensure-owner                     first run only: asks for an email and password
"""

import getpass
import sys

from sqlalchemy import select

from app.db import session_factory
from app.models import Role, User
from app.security import hash_password


def create_owner(email: str) -> None:
    password = getpass.getpass("Password (min 10 chars): ")
    if len(password) < 10:
        sys.exit("Password too short")
    db = session_factory()()
    try:
        if db.scalar(select(User).where(User.email == email.lower())):
            sys.exit("User already exists")
        db.add(User(email=email.lower(), name=email.split("@")[0], password_hash=hash_password(password), role=Role.OWNER))
        db.commit()
        print(f"Owner {email} created")
    finally:
        db.close()


def ensure_owner() -> None:
    """Used by start-local: creates the first owner, does nothing once one exists."""
    db = session_factory()()
    try:
        if db.scalar(select(User).where(User.role == Role.OWNER)):
            print("Owner already exists")
            return
    finally:
        db.close()
    print("Create the first login (owner) for the web app.")
    create_owner(input("Email: ").strip())


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "create-owner":
        create_owner(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] == "ensure-owner":
        ensure_owner()
    else:
        sys.exit("usage: python -m app.cli create-owner EMAIL | ensure-owner")
