"""Generate docs/architecture.excalidraw (high-level system map). Run: python scripts/gen_architecture.py

Every piece of text is bound to a container (box, frame label or arrow) so Excalidraw positions it.
"""
import json
import random
from pathlib import Path

random.seed(7)
elements = []
COLORS = {'ui': '#a5d8ff', 'api': '#b2f2bb', 'orch': '#ffec99', 'agent': '#ffc9c9',
          'db': '#d0bfff', 'store': '#e9ecef', 'todo': '#ffffff', 'none': 'transparent'}
W = 1500  # canvas content width


def _id():
    return f'el{len(elements)}_{random.randint(10**6, 10**7)}'


def base(kind, x, y, w, h, **extra):
    return {'id': _id(), 'type': kind, 'x': x, 'y': y, 'width': w, 'height': h, 'angle': 0,
            'strokeColor': '#1e1e1e', 'backgroundColor': 'transparent', 'fillStyle': 'solid',
            'strokeWidth': 2, 'strokeStyle': 'solid', 'roughness': 1, 'opacity': 100,
            'groupIds': [], 'frameId': None, 'roundness': None, 'seed': random.randint(1, 2**31),
            'version': 1, 'versionNonce': random.randint(1, 2**31), 'isDeleted': False,
            'boundElements': [], 'updated': 1, 'link': None, 'locked': False, **extra}


def bound_text(container, value, size, align='center', valign='middle'):
    lines = value.split('\n')
    h = len(lines) * size * 1.25
    w = min(container['width'] - 16, max(len(l) for l in lines) * size * 0.6) if container['type'] != 'arrow' \
        else max(len(l) for l in lines) * size * 0.6
    if container['type'] == 'arrow':
        x, y = container['x'], container['y']
    else:
        x = container['x'] + 8 if align == 'left' else container['x'] + (container['width'] - w) / 2
        y = container['y'] + 8 if valign == 'top' else container['y'] + (container['height'] - h) / 2
    t = base('text', x, y, w, h, text=value, originalText=value, fontSize=size, fontFamily=1,
             textAlign=align, verticalAlign=valign, containerId=container['id'], lineHeight=1.25,
             autoResize=True, strokeWidth=1)
    elements.append(t)
    container['boundElements'].append({'type': 'text', 'id': t['id']})
    return t


def box(x, y, w, h, label, color, size=16, dashed=False, stroke=True, align='center', valign='middle'):
    rect = base('rectangle', x, y, w, h, backgroundColor=COLORS[color], roundness={'type': 3},
                strokeStyle='dashed' if dashed else 'solid',
                strokeColor='#1e1e1e' if stroke else 'transparent')
    elements.append(rect)
    bound_text(rect, label, size, align, valign)
    return rect


def label(x, y, w, h, value, size, align='left'):
    """Free-standing text, held in an invisible box so it stays where it is placed."""
    return box(x, y, w, h, value, 'none', size, stroke=False, align=align)


def frame(x, y, w, h, title):
    rect = base('rectangle', x, y, w, h, strokeStyle='dashed', strokeWidth=1, roundness={'type': 3},
                strokeColor='#868e96')
    elements.append(rect)
    label(x + 10, y + 6, w - 20, 30, title, 18)
    return rect


def anchor(r, side, shift=0):
    cx, cy = r['x'] + r['width'] / 2 + shift, r['y'] + r['height'] / 2
    return {'top': (cx, r['y']), 'bottom': (cx, r['y'] + r['height']),
            'left': (r['x'], cy), 'right': (r['x'] + r['width'], cy)}[side]


def arrow(a, b, text=None, dashed=False, sides=('bottom', 'top'), via=(), shift=(0, 0)):
    (x1, y1), (x2, y2) = anchor(a, sides[0], shift[0]), anchor(b, sides[1], shift[1])
    pts = [[0, 0]] + [[vx - x1, vy - y1] for vx, vy in via] + [[x2 - x1, y2 - y1]]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    el = base('arrow', x1, y1, max(xs) - min(xs), max(ys) - min(ys), points=pts,
              strokeStyle='dashed' if dashed else 'solid', roundness=None if via else {'type': 2},
              startBinding={'elementId': a['id'], 'focus': 0, 'gap': 4},
              endBinding={'elementId': b['id'], 'focus': 0, 'gap': 4},
              startArrowhead=None, endArrowhead='arrow', lastCommittedPoint=None, elbowed=False)
    elements.append(el)
    a['boundElements'].append({'type': 'arrow', 'id': el['id']})
    b['boundElements'].append({'type': 'arrow', 'id': el['id']})
    if text:
        bound_text(el, text, 14)
    return el


# --- title -------------------------------------------------------------------------------------------
label(40, 10, W, 40, 'AfterHours - Accrual Correction Assistant: high-level architecture', 28)
label(40, 52, W, 26, 'Solid border = built & tested     Dashed border = stub / not built yet     '
      'All data synthetic, USD, integer cents', 16)

# --- people ------------------------------------------------------------------------------------------
reviewer = box(100, 100, 260, 70, 'Reviewer / accountant\n(browser)', 'store')
mail = box(1180, 100, 300, 70, 'Approval email\n(approval_watcher scaffold)', 'todo', dashed=True)

# --- frontend + API ----------------------------------------------------------------------------------
frame(60, 200, 1440, 170, 'Frontend + API   (Docker services: frontend, api)')
ui = box(100, 250, 340, 95, 'React review workspace\n25-state graph\nmock adapter today', 'ui')
api = box(570, 250, 420, 95, 'Python FastAPI  (backend/api)\ncreate-review | list-review | get-review (SSE)\n'
          'export-review = 501 (TODO)', 'api', 15)
calc = box(1120, 250, 360, 95, 'Calculator / build_proposal\n$7,700 target | +$700 adjustment\n'
           'balanced journal + hash', 'api', 15)

# --- workers -----------------------------------------------------------------------------------------
frame(60, 410, 1440, 300, 'Workers   (Python processes; Docker profile "pipeline")')
orch = box(100, 470, 260, 130, 'Orchestrator\nafterhours-orchestrate\npolls DB, start_review,\ndispatches jobs', 'orch', 15)
ext = box(450, 470, 300, 130, 'EXTRACTION\nBitdeer  DeepSeek-V4.1-Flash\ncontract + amendment text\n-> quoted rate facts\n(token budget)', 'agent', 14)
mat = box(840, 470, 270, 130, 'MATCHING\nFactory (Droid)\nwork items <-> contract,\ninvoices, ledger', 'agent', 14)
inv = box(1200, 470, 280, 130, 'INVESTIGATION\nFactory (Droid)\nreads mailbox, checks\nsigner, dates, amendment', 'agent', 14)
tools = box(450, 635, 1030, 55, 'Read-only agent tools (afterhours_db.tools):  searchEmails | readEmailThread | '
            'readAttachment | getCaseEvidence', 'agent', 14)

# --- data layer --------------------------------------------------------------------------------------
frame(60, 750, 1440, 300, 'Data layer   (afterhours_db Python SDK -> SpacetimeDB over HTTP + WebSocket)')
sdk = box(100, 800, 360, 110, 'afterhours_db SDK\nCSV/JSON parsers, imports, cases,\njobs + leases, mailbox,\nseed, smoke tests', 'db', 15)
ids = box(100, 935, 360, 90, 'Identities\nowner (setup) | GATEWAY (API)\nWORKER (agents)\ntokens in backend/.secrets', 'store', 14)
stdb = box(540, 800, 560, 225, 'SpacetimeDB module  (TypeScript, db "accrual-docs")\n\n'
           'Private tables + sender-checked views:\ndocuments, cases, facts, work_items, invoice_lines,\n'
           'ledger_records, allocations, emails, attachments,\njobs, job_results, proposals, posting periods, settings\n\n'
           'Reducers: finalize_import, start_review, claim / heartbeat /\ncomplete_job, build_proposal   |   lease sweep every 2s',
           'db', 13)
files = box(1180, 800, 300, 120, 'File store\ndata/files/sha256/...\ncontent-addressed originals,\nre-hashed on every read', 'store', 14)

# --- footer ------------------------------------------------------------------------------------------
label(60, 1075, W, 50, 'Demo flow:  upload -> finalize_import -> IMPORTED -> EXTRACTING -> MATCHING -> INVESTIGATING '
      '-> proposal -> [approval: TODO] -> [CSV export: TODO]\nAgent facts stay PROPOSED; agents never approve, export or post.', 16)
label(60, 1130, W, 30, 'Left to build:  auto-run calculator from orchestrator  |  approval (email vs reviewer screen)  |  '
      'export-review CSV  |  connect frontend to API  |  revision bumps', 16)

# --- arrows ------------------------------------------------------------------------------------------
arrow(reviewer, ui)
arrow(ui, api, 'HTTP (planned)', dashed=True, sides=('right', 'left'))
arrow(api, calc, 'gateway', sides=('right', 'left'))
arrow(mail, calc, 'approve (TODO)', dashed=True)
# API -> SDK: down the left margin, outside the workers frame.
(ax, ay) = anchor(api, 'bottom', -150)
arrow(api, sdk, 'uploads + reads', sides=('bottom', 'top'), shift=(-150, 0),
      via=[(ax, 385), (30, 385), (30, 780), (280, 780)])
# Calculator -> SpacetimeDB: down the right margin.
(cx, cy) = anchor(calc, 'bottom')
arrow(calc, stdb, 'build_proposal', sides=('bottom', 'top'), shift=(0, 200),
      via=[(cx, 385), (1530, 385), (1530, 780), (1020, 780)])
arrow(orch, ext, 'claims', sides=('right', 'left'))
arrow(ext, mat, 'then', sides=('right', 'left'))
arrow(mat, inv, 'if questions', sides=('right', 'left'))
arrow(ext, tools)
arrow(inv, tools)
arrow(orch, sdk, 'worker + gateway tokens')
arrow(tools, stdb)
arrow(sdk, stdb, sides=('right', 'left'))
arrow(stdb, files, 'hash + metadata', sides=('right', 'left'))

doc = {'type': 'excalidraw', 'version': 2, 'source': 'https://excalidraw.com', 'elements': elements,
       'appState': {'viewBackgroundColor': '#ffffff', 'gridSize': None}, 'files': {}}
out = Path(__file__).resolve().parents[1] / 'docs' / 'architecture.excalidraw'
out.write_text(json.dumps(doc, indent=1))
print(f'wrote {out} ({len(elements)} elements)')
