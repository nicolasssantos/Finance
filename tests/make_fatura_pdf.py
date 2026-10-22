"""Gera um PDF com cada texto numa posição exata (como as faturas do banco, feitas com iText: um item de texto por coluna).
Uso: python3 -I tests/make_fatura_pdf.py spec.json saida.pdf   (spec: {"pages": [[{"y": 700, "cells": [[x, "texto", "L"|"R"], ...]}, ...], ...]})"""
import json
import sys
from reportlab.pdfgen import canvas

spec = json.load(open(sys.argv[1], encoding="utf-8"))
c = canvas.Canvas(sys.argv[2], pagesize=(595.224, 841.824))
for page in spec["pages"]:
    for line in page:
        for x, text, align in line["cells"]:
            c.setFont("Helvetica", 7)
            (c.drawRightString if align == "R" else c.drawString)(x, line["y"], text)
    c.showPage()
c.save()
