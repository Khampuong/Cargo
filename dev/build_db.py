"""
สร้างไฟล์ฐานข้อมูลเปล่า (Database Cargo.xlsx) จากโครงสร้างใน gas/Code.gs
นำไปอัปโหลดเป็น Google Sheet ได้ทันที (ชีต/ฟิลด์ตรงกับที่ระบบใช้)

    node dev/dump_schema.js > schema.json
    python dev/build_db.py schema.json "Database Cargo.xlsx"
"""
import json
import sys
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

schema = json.load(open(sys.argv[1], encoding="utf-8"))
out = sys.argv[2]

HEAD_FILL = PatternFill("solid", fgColor="DCE9EF")
WIDTH = {"Timestamp": 20, "LastLogin": 20, "CreatedAt": 20, "LastSeen": 20, "Email": 28, "Owner": 28,
         "Name": 22, "Mover": 20, "Pickup": 22, "Dropoff": 22, "Source": 28, "Photo": 30, "TokenHash": 30}

wb = Workbook()
wb.remove(wb.active)
now = datetime.now().replace(microsecond=0)

ORDER = ["Moves", "Users", "Products", "Devices", "Refs"]
for name in sorted(schema["sheets"], key=lambda n: ORDER.index(n) if n in ORDER else 99):
    fields = schema["sheets"][name]
    ws = wb.create_sheet(name)
    ws.append(fields)
    # ข้อมูลตั้งต้น (ต้องใส่ก่อนจัดรูปแบบวันที่ ไม่อย่างนั้นแถวจะต่อท้ายหลังแถวที่จัดรูปแบบไว้)
    if name == "Products":
        for code, pname, unit in schema["products"]:
            ws.append([code, pname, unit, True])
    if name == "Users":
        for email in schema["admins"]:
            row = {"Email": email, "Name": email, "Role": "admin", "Active": True, "CreatedAt": now}
            ws.append([row.get(h, "") for h in fields])
    for i, h in enumerate(fields, 1):
        c = ws.cell(row=1, column=i)
        c.font, c.fill = Font(bold=True), HEAD_FILL
        ws.column_dimensions[get_column_letter(i)].width = WIDTH.get(h, 14)
    ws.freeze_panes = "A2"

doc = wb.create_sheet(schema["docSheet"])
for r in schema["docs"]:
    doc.append(r)
for i, w in enumerate([28, 14, 48, 34], 1):
    doc.column_dimensions[get_column_letter(i)].width = w
    doc.cell(row=1, column=i).font, doc.cell(row=1, column=i).fill = Font(bold=True), HEAD_FILL
doc.freeze_panes = "A2"

wb.save(out)
print("saved", out, [ws.title for ws in wb.worksheets])
