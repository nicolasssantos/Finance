"""Protege um PDF com senha (RC4-128) para o teste de PDF com senha. Uso: python3 -I tests/encrypt_pdf.py entrada.pdf saida.pdf senha"""
import sys
from pypdf import PdfReader, PdfWriter

reader = PdfReader(sys.argv[1])
writer = PdfWriter(clone_from=reader)
writer.encrypt(sys.argv[3], algorithm="RC4-128")
with open(sys.argv[2], "wb") as f:
    writer.write(f)
