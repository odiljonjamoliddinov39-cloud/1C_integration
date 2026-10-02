"""Monthly audit report per company as PDF: findings by severity, fixed vs open, open list."""

from __future__ import annotations

import io
import os
from datetime import date, datetime, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import AuditFinding, Company, Fix
from app.services.audit.engine import RULES, SEVERITY_ORDER

FONT_DIRS = ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu"]
SEVERITIES = ["critical", "high", "medium", "low"]


def _register_fonts() -> tuple[str, str]:
    for d in FONT_DIRS:
        regular, bold = os.path.join(d, "DejaVuSans.ttf"), os.path.join(d, "DejaVuSans-Bold.ttf")
        if os.path.exists(regular) and os.path.exists(bold):
            if "DejaVu" not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont("DejaVu", regular))
                pdfmetrics.registerFont(TTFont("DejaVu-Bold", bold))
            return "DejaVu", "DejaVu-Bold"
    return "Helvetica", "Helvetica-Bold"  # no Cyrillic; install fonts-dejavu-core


def month_bounds(month: str) -> tuple[datetime, datetime]:
    start = datetime.strptime(month + "-01", "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end


def report_data(db: Session, company: Company, month: str) -> dict:
    from app.services.audit import rules  # noqa: F401  (register titles)

    start, end = month_bounds(month)
    findings = list(
        db.scalars(
            select(AuditFinding).where(
                AuditFinding.company_id == company.id,
                AuditFinding.first_seen < end,
                or_(AuditFinding.resolved_at.is_(None), AuditFinding.resolved_at >= start),
            )
        )
    )
    table = {s: {"found": 0, "fixed": 0, "open": 0, "ignored": 0} for s in SEVERITIES}
    for f in findings:
        row = table[f.severity]
        if f.first_seen >= start:
            row["found"] += 1
        if f.status == "fixed" and f.resolved_at and start <= f.resolved_at < end:
            row["fixed"] += 1
        elif f.status == "ignored":
            row["ignored"] += 1
        elif f.status == "open":
            row["open"] += 1
    applied_count = db.scalar(
        select(func.count(Fix.id)).where(Fix.company_id == company.id, Fix.applied_at >= start, Fix.applied_at < end)
    )
    open_list = sorted(
        (f for f in findings if f.status == "open"), key=lambda f: (SEVERITY_ORDER[f.severity], f.rule_code)
    )
    return {"by_severity": table, "fixes_applied": applied_count, "open": open_list}


def render_pdf(db: Session, company: Company, month: str) -> bytes:
    regular, bold = _register_fonts()
    data = report_data(db, company, month)
    styles = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=styles["Normal"], fontName=regular, fontSize=9, leading=12)
    title = ParagraphStyle("title", parent=styles["Title"], fontName=bold, fontSize=16)
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontName=bold, fontSize=12)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=15 * mm)
    story = [
        Paragraph(f"Аудит-отчёт: {company.name}", title),
        Paragraph(f"ИНН {company.inn or '—'} · период {month} · сформирован {date.today():%d.%m.%Y}", body),
        Spacer(1, 6 * mm),
        Paragraph("Замечания по важности", h2),
    ]
    rows = [["Важность", "Найдено за месяц", "Исправлено", "Открыто", "Скрыто"]]
    for sev in SEVERITIES:
        r = data["by_severity"][sev]
        rows.append([sev, r["found"], r["fixed"], r["open"], r["ignored"]])
    t = Table(rows, colWidths=[35 * mm, 35 * mm, 30 * mm, 30 * mm, 30 * mm])
    t.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), regular),
                ("FONTNAME", (0, 0), (-1, 0), bold),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef2f7")),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c8cfd8")),
                ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
            ]
        )
    )
    story += [t, Spacer(1, 3 * mm), Paragraph(f"Применено исправлений за месяц: {data['fixes_applied']}", body)]

    story += [Spacer(1, 6 * mm), Paragraph("Открытые замечания", h2)]
    if not data["open"]:
        story.append(Paragraph("Открытых замечаний нет.", body))
    for f in data["open"]:
        rule_title = RULES[f.rule_code].title if f.rule_code in RULES else ""
        story.append(Paragraph(f"<b>{f.rule_code}</b> ({f.severity}) — {rule_title}", body))
        story.append(Paragraph(f.message, body))
        if f.ai_explanation:
            story.append(Paragraph(f"<i>{f.ai_explanation}</i>", body))
        story.append(Spacer(1, 2 * mm))
    doc.build(story)
    return buf.getvalue()
