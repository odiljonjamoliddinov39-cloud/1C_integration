"""Audit rules. Each module registers its rules with `@rule`; adding a rule = one function + one test."""

from app.services.audit.rules import (  # noqa: F401
    cash,
    debts,
    documents,
    duplicates,
    master_data,
    stock,
    vat,
)
