"""Read-only QuickBooks sandbox connectivity check; never posts journals or prints tokens."""
import json
from pathlib import Path

import httpx
from dotenv import load_dotenv
from afterhours_db.intuit import QuickBooks, SANDBOX, qbo_accounts


def main():
    load_dotenv(Path(__file__).resolve().parents[2] / '.env')
    qb = QuickBooks()
    operation = 'company information'
    try:
        company = qb.request('GET', f'companyinfo/{qb.realm}')['CompanyInfo']
        print(json.dumps({'sandbox': SANDBOX, 'company': company.get('CompanyName'), 'connection': 'OK'}), flush=True)
        operation = 'chart of accounts'
        accounts = qb.query('select * from Account MAXRESULTS 1000')
        expense, liability = qbo_accounts(accounts, {
            'expense_account': {'code': '6100'}, 'liability_account': {'code': '2105'}})
        selected = [dict(id=row['Id'], name=row.get('Name'), type=row.get('AccountType'), active=row.get('Active', True))
                    for row in accounts if str(row['Id']) in (expense, liability)]
        print(json.dumps({'accounts_read': len(accounts), 'mapped_accounts': selected}), flush=True)
        for entity in ('Bill', 'TimeActivity', 'JournalEntry'):
            operation = entity
            rows = qb.query(f'select * from {entity} MAXRESULTS 1000')
            result = {'entity': entity, 'records_read': len(rows)}
            if entity == 'Bill':
                result['available_periods'] = sorted({row.get('TxnDate', '')[:7] for row in rows if row.get('TxnDate')})
            if entity == 'JournalEntry':
                result['existing_afterhours_entries'] = sum('AfterHours ' in (row.get('PrivateNote') or '') for row in rows)
            print(json.dumps(result), flush=True)
        print('PASS: sandbox company, account mapping, bills, time activities, and journal reads. No journal posted.', flush=True)
    except httpx.HTTPStatusError as error:
        print(json.dumps({'operation': operation, 'http_status': error.response.status_code, 'result': 'FAILED'}), flush=True)
        raise SystemExit(1) from None
    except (httpx.HTTPError, RuntimeError, KeyError, ValueError) as error:
        print(json.dumps({'operation': operation, 'error_type': type(error).__name__, 'result': 'FAILED'}), flush=True)
        raise SystemExit(1) from None
    finally:
        qb.close()


if __name__ == '__main__':
    main()
