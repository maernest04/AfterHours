"""Summarize saved Enron benchmark artifacts without rerunning model calls."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path


def generate(directory, output):
    probes = [json.loads(path.read_text()) for path in directory.glob('probe-*.json')]
    runs = [(path, json.loads(path.read_text())) for path in directory.glob('factory-*-c*-*.json')]
    runs.sort(key=lambda item: item[1]['timestamp'])
    public = [json.loads(path.read_text()) for path in sorted(directory.glob('public-contracts-*.json'))]
    imported = json.loads((directory/'import-report.json').read_text())
    lines = ['# Enron stress-test results', '',
             f'Generated {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")} from saved local artifacts.', '',
             f'Imported **{imported["imported"]["email"]:,} public Enron emails** and '
             f'**{imported["imported"]["attachment"]:,} attachment texts** into isolated `{imported["database"]}`.', '',
             '## Retrieval probes', '',
             '| Public emails | Queries | p50 | p95 | Largest search response |',
             '| ---: | ---: | ---: | ---: | ---: |']
    for row in sorted(probes, key=lambda row:row['public_emails']):
        lines.append(f'| {row["public_emails"]:,} | {row["queries"]} | {row["retrieval_p50_seconds"]*1000:.0f} ms | '
                     f'{row["retrieval_p95_seconds"]*1000:.0f} ms | {row["max_search_response_bytes"]:,} bytes |')
    lines += ['', 'Local SQLite FTS5 supplies candidates; SpacetimeDB authorizes and reads the sources. '
              'The corpus is indexed, not passed wholesale into the model.', '',
              '## Live Factory accounting runs', '',
              '| Public emails | Worker limit | Correct | Unsupported resolutions | p95 case time | Notes |',
              '| ---: | ---: | ---: | ---: | ---: | --- |']
    for path, row in runs:
        errors=[case.get('error','') for case in row['cases'] if not case['correct']]
        note='; '.join(sorted({error.split(':')[0] for error in errors})) or 'Passed'
        if row.get('latency_measurement_caveat'):
            note='Regression tests overlapped; timing not comparable'
        latency='Excluded' if row.get('latency_measurement_caveat') else f'{row["latency_p95_seconds"]:.1f} s'
        lines.append(f'| {row["public_imported"]["email"]:,} | {row["concurrency"]} | {row["correct"]}/{row["total"]} | '
                     f'{row["unsupported_resolutions"]} | {latency} | {note} |')
    if runs:
        latest=runs[-1][1]
        peak=latest.get('database_peak_rss_kib')
        if peak:
            lines += ['', f'Latest run sampled database peak RSS: **{peak/1024:.0f} MiB**. This excludes the '
                      'Python/Factory processes and is not a machine-wide memory measurement.']
    if public:
        latest=public[-1]
        lines += ['', '## Real contract retrieval', '',
                  f'**{latest["correct"]}/{latest["total"]} passed** over {latest["public_emails"]:,} public emails: '
                  'the Utility Construction Escrow Agreement and the Communications Services Agreement. '
                  'Each result required a relevant source document and an exact line/excerpt.', '',
                  'Two manually inspected title-retrieval questions are a smoke test, not a representative '
                  'contract-understanding accuracy estimate.']
    lines += ['', '## Findings and limits', '',
              '- The first five-worker run exposed a stale-lease failure. A quadratic proposal source-version '
              'scan was replaced with a single pass; later runs retain the original failure in the history.',
              '- The first 20-worker run passed 18/20. Two missing-evidence cases guessed thread IDs; '
              'scope checks denied access. Unavailable evidence now returns bounded tool feedback so '
              'the agent can finish unresolved without reading unauthorized data.',
              '- Bulk import hit HTTP payload limits; batches now bound encoded bytes as well as row count. '
              'A controlled server restart preserved checkpoints and sharply improved ingestion throughput. '
              'Treat that transient query/view-state bottleneck as an operational finding.',
              '- Source views now use query-builder plans. Search and proposal inputs contain only bounded '
              'retrieved/case evidence rather than the whole mailbox.',
              '- Accounting cases are synthetic signed/unsigned/missing/conflicting/injection scenarios. '
              'EXTRACTION and MATCHING are replayed; Investigation uses live Factory calls. Draft cases '
              'expect a $7,700 target, $700 adjustment and $7,700 full draft export amount.',
              '- All public messages share artificial vendor ENRON-BENCH; original parties/dates remain in '
              'the source records. Selection follows archive order, and normalized-subject threading is approximate.',
              f'- {imported["body_truncations"]:,} imported email bodies exceed the existing 20,000-character '
              'mailbox limit; full raw records remain in the corpus. Attachments are text renderings, not original binaries.',
              '- Small case counts cannot establish 95% production accuracy. No human approval, export, '
              'general tax reasoning or real Enron accrual corrections are validated.',
              '- Raw JSON artifacts retain per-case decisions, search/date bounds, source IDs, model/usage '
              'observations and errors. No dollar-cost conversion is inferred from SDK credits.', '',
              'Reproduction: [ENRON_STRESS.md](../backend/agents/ENRON_STRESS.md). '
              'Raw artifacts are under `data/enron/` and excluded from version control.', '',
              'Source: [University of Maryland / TREC EDRM Enron v2]'
              '(https://trec-legal.umiacs.umd.edu/corpora/trec/legal10/). '
              'Attribution: EDRM Enron Email Data Set, produced by ZL Technologies, Inc. '
              '(http://www.zlti.com), CC BY 3.0 US.', '']
    output.write_text('\n'.join(lines))
    print(output)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=Path('data/enron'))
    parser.add_argument('--output',type=Path,default=Path('docs/ENRON_STRESS_RESULTS.md'))
    args=parser.parse_args()
    generate(args.directory,args.output)


if __name__=='__main__':
    main()
