"""Minimal PDF writer for test fixtures: multi-page text with font sizes, bold, and an outline."""
import sys, random

def esc(s):
    return s.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')

class Pdf:
    def __init__(self):
        self.pages = []   # list of content strings
        self.outline = [] # (title, page_index)
    def page(self):
        self.pages.append([])
        return len(self.pages) - 1
    def text(self, pi, x, y, s, size=11, bold=False):
        f = '/F2' if bold else '/F1'
        self.pages[pi].append(f'BT {f} {size} Tf {x} {y} Td ({esc(s)}) Tj ET')
    def write(self, path):
        objs = []
        def add(body):
            objs.append(body); return len(objs)
        # 1 catalog, 2 pages, 3 F1, 4 F2 reserved
        add(None); add(None)
        add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
        add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
        page_ids = []
        for content in self.pages:
            stream = '\n'.join(content).encode('latin-1')
            cid = add(f'<< /Length {len(stream)} >>\nstream\n'.encode() + stream + b'\nendstream')
            pid = add(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {cid} 0 R >>')
            page_ids.append(pid)
        kids = ' '.join(f'{p} 0 R' for p in page_ids)
        objs[1] = f'<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>'
        outline_ref = ''
        if self.outline:
            oid = add(None)  # outlines root
            item_ids = [add(None) for _ in self.outline]
            for i, (title, pi) in enumerate(self.outline):
                parts = [f'/Title ({esc(title)}) /Parent {oid} 0 R /Dest [{page_ids[pi]} 0 R /XYZ 0 792 0]']
                if i > 0: parts.append(f'/Prev {item_ids[i-1]} 0 R')
                if i < len(self.outline) - 1: parts.append(f'/Next {item_ids[i+1]} 0 R')
                objs[item_ids[i]-1] = '<< ' + ' '.join(parts) + ' >>'
            objs[oid-1] = f'<< /Type /Outlines /First {item_ids[0]} 0 R /Last {item_ids[-1]} 0 R /Count {len(item_ids)} >>'
            outline_ref = f' /Outlines {oid} 0 R /PageMode /UseOutlines'
        objs[0] = f'<< /Type /Catalog /Pages 2 0 R{outline_ref} >>'
        out = bytearray(b'%PDF-1.4\n')
        offsets = []
        for i, body in enumerate(objs):
            offsets.append(len(out))
            b = body if isinstance(body, bytes) else body.encode('latin-1')
            out += f'{i+1} 0 obj\n'.encode() + b + b'\nendobj\n'
        xref = len(out)
        out += f'xref\n0 {len(objs)+1}\n0000000000 65535 f \n'.encode()
        for o in offsets: out += f'{o:010d} 00000 n \n'.encode()
        out += f'trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
        open(path, 'wb').write(bytes(out))

WORDS = 'the quick brown fox jumps over a lazy dog while reading about design form space order and habit systems that compound over time'.split()
random.seed(1)
def para(n=60):
    ws = [random.choice(WORDS) for _ in range(n)]
    ws[0] = ws[0].capitalize()
    s, out, line = ' '.join(ws) + '.', [], ''
    for w in s.split(' '):
        if len(line) + len(w) > 85: out.append(line); line = w
        else: line = (line + ' ' + w).strip()
    out.append(line)
    return out

def body(pdf, pi, y, paras=3, header=None, footer=None):
    if header: pdf.text(pi, 72, 750, header, 9)
    for _ in range(paras):
        for ln in para():
            pdf.text(pi, 72, y, ln, 11); y -= 14
        y -= 10
    if footer: pdf.text(pi, 300, 40, footer, 9)

# ---------- Fixture 1: outline ----------
p = Pdf()
chapters = [('Introduction', 0), ('Chapter 1 - The Fundamentals', 2), ('Chapter 2 - Space and Form', 5), ('Chapter 3 - Organisation', 8), ('Conclusion', 11)]
starts = {pi: t for t, pi in chapters}
for i in range(12):
    pi = p.page()
    y = 700
    if i in starts:
        p.text(pi, 72, 700, starts[i], 20, bold=True); y = 660
    body(p, pi, y, header='Architecture Form Space & Order', footer=str(i+1))
p.outline = chapters
p.write('book_outline.pdf')

# ---------- Fixture 2: table of contents, no outline ----------
p = Pdf()
pi = p.page(); p.text(pi, 72, 600, 'Atomic Habits', 30, bold=True); p.text(pi, 72, 560, 'A test book', 14)
pi = p.page(); p.text(pi, 72, 700, 'Contents', 20, bold=True)
toc = [('Introduction', 1), ('Chapter 1: The Surprising Power', 3), ('Chapter 2: How Habits Shape You', 6), ('Chapter 3: Build Better Habits', 9), ('Conclusion', 12)]
y = 660
for t, n in toc:
    p.text(pi, 72, y, f'{t} ' + '.' * (60 - len(t)) + f' {n}', 12); y -= 20
# printed page 1 == pdf page 3 (offset 2)
starts = {n + 1: t for t, n in toc}   # pdf page index = printed + 2 - 1
for printed in range(1, 13):
    pi = p.page(); y = 700
    if pi in starts:
        p.text(pi, 72, 700, starts[pi], 18, bold=True); y = 660
    body(p, pi, y, header='ATOMIC HABITS', footer=str(printed))
p.write('book_toc.pdf')

# ---------- Fixture 3: headings only ----------
p = Pdf()
heads = {0: 'CHAPTER 1', 1: None, 3: 'Chapter Two', 6: '3. The Third Part', 9: 'Epilogue'}
sub = {0: 'Beginnings', 3: 'The Middle', 6: None, 9: None}
for i in range(11):
    pi = p.page(); y = 700
    if heads.get(i):
        p.text(pi, 72, 700, heads[i], 22, bold=True); y = 670
        if sub.get(i):
            p.text(pi, 72, 670, sub[i], 16, bold=True); y = 640
    body(p, pi, y, header='University Reading', footer=f'Page {i+1}')
p.write('book_headings.pdf')

# ---------- Fixture 4: two columns, recurring body phrase, numeric body line ----------
p = Pdf()
def col(pdf, pi, x, y, n=14, width=38):
    for _ in range(n):
        ws = [random.choice(WORDS) for _ in range(7)]
        pdf.text(pi, x, y, ' '.join(ws)[:width], 10); y -= 13
for i in range(6):
    pi = p.page()
    p.text(pi, 200, 760, 'Journal of Testing', 9)            # running header (edge)
    if i == 0:
        p.text(pi, 72, 720, 'Two Column Article', 18, bold=True)  # full-width heading
    p.text(pi, 72, 685, 'LEFT-START-MARKER', 10)     # below the top 12% band, so not a header
    col(p, pi, 72, 670)
    p.text(pi, 72, 480, 'LEFT-END-MARKER', 10)
    p.text(pi, 320, 685, 'RIGHT-START-MARKER', 10)
    col(p, pi, 320, 670)
    p.text(pi, 320, 480, 'RIGHT-END-MARKER', 10)
    p.text(pi, 72, 450, 'Remember: habits compound.', 10)      # recurring body line (must survive)
    p.text(pi, 72, 435, '2024', 10)                             # numeric body line (must survive)
    p.text(pi, 300, 40, str(i + 1), 9)                          # page number (edge, drop)
p.write('book_columns.pdf')

# ---------- Fixture 5: blank page, duplicate outline titles, long unpunctuated paragraph ----------
p = Pdf()
for i in range(8):
    pi = p.page()
    if i == 2:
        continue                                                # page 3 is blank
    y = 700
    if i in (0, 3, 5):
        p.text(pi, 72, 700, {0: 'Exercise', 3: 'Exercise', 5: 'Answers'}[i], 20, bold=True); y = 660
    if i == 4:
        long = ' '.join(random.choice(WORDS) for _ in range(140))
        for k in range(0, len(long), 85):
            p.text(pi, 72, y, long[k:k+85], 11); y -= 14
    else:
        body(p, pi, y, header='Workbook', footer=str(i + 1))
p.outline = [('Exercise', 0), ('Part opener', 2), ('Exercise', 3), ('Answers', 5)]
p.write('book_blank.pdf')

# ---------- Fixture 6: scanned (no text layer) ----------
p = Pdf()
for i in range(2):
    pi = p.page()
    p.pages[pi].append('0.9 g 72 72 468 648 re f')                  # a grey box, no text
p.write('book_scanned.pdf')
print('ok')
