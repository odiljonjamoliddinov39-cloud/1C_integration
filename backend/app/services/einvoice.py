"""E-invoicing operator integration behind one interface.

Didox, Faktura.uz or Soliq can be swapped in by implementing `EinvoiceProvider` and registering
it in `PROVIDERS`. Which operator the companies use is still an open question, so v1 ships the
stub: "Send to operator" only marks the invoice ready to send.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.config import get_settings
from app.models import Company, Invoice


@dataclass
class SendResult:
    status: str  # ready | sent | signed | rejected
    operator_id: str | None = None
    message: str = ""


class EinvoiceProvider(Protocol):
    name: str

    def send(self, invoice: Invoice, company: Company) -> SendResult: ...

    def get_status(self, invoice: Invoice, company: Company) -> SendResult: ...


class StubProvider:
    name = "stub"

    def send(self, invoice: Invoice, company: Company) -> SendResult:
        return SendResult(
            status="ready",
            operator_id=None,
            message="Operator not connected yet: marked ready to send",
        )

    def get_status(self, invoice: Invoice, company: Company) -> SendResult:
        return SendResult(status=invoice.status, operator_id=invoice.operator_id, message=invoice.operator_message)


PROVIDERS: dict[str, type] = {"stub": StubProvider}


def get_provider() -> EinvoiceProvider:
    return PROVIDERS[get_settings().einvoice_provider]()
