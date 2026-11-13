from pypdf import PdfReader
import json
import os

# Paths are relative to this file, so it works whatever folder the server or tests start from.
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# Read LinkedIn PDF
try:
    reader = PdfReader(os.path.join(DATA, "linkedin.pdf"))
    linkedin = ""
    for page in reader.pages:
        text = page.extract_text()
        if text:
            linkedin += text
except FileNotFoundError:
    linkedin = "LinkedIn profile not available"

# Read other data files
with open(os.path.join(DATA, "summary.txt"), "r", encoding="utf-8") as f:
    summary = f.read()

with open(os.path.join(DATA, "style.txt"), "r", encoding="utf-8") as f:
    style = f.read()

with open(os.path.join(DATA, "facts.json"), "r", encoding="utf-8") as f:
    facts = json.load(f)