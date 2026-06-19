# DevFlow Lean Skills

ชุดนี้เป็นเวอร์ชัน lean ของ DevFlow authoring skills โดยแยก core rules, schema, reviewer และ examples ออกจากกันเพื่อลด context noise

## Files

1. `00-skill-router.md`
   - ใช้เป็นตัวบอกว่า task แบบไหนควรโหลด skill ไหน
   - ควรโหลดเสมอก่อนเลือก skill รายละเอียด

2. `01-authoring-core.md`
   - กฎหลักสำหรับเขียน DevFlow card
   - โหลดทุกครั้งที่สร้าง/อัปเดตการ์ดจาก Jira/repo

3. `02-schema-reference.md`
   - field, enum, validation, placement rule
   - โหลดเฉพาะตอนจะ call create/update task หรือเช็ก JSON

4. `03-reviewer-core.md`
   - กฎรีวิว card ที่อยู่ ready-for-review
   - โหลดเฉพาะตอนตรวจงาน/เลื่อน done/in-progress

5. `04-examples.md`
   - ตัวอย่าง JSON และ pattern
   - โหลดเฉพาะตอนต้องการดู sample หรือ agent เขียนผิด format

## Recommended loading

### Create or update implementation card
Load:
- `00-skill-router.md`
- `01-authoring-core.md`
- `02-schema-reference.md`

Load `04-examples.md` only when output format is unclear.

### Review ready-for-review card
Load:
- `00-skill-router.md`
- `03-reviewer-core.md`
- `02-schema-reference.md`

### Token saving
Do not load examples by default. Most runs only need core + schema.
