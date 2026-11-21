"""Size nonzero fixture rates for devnet deposits (meter balances use fixed-point units)."""
import json,sys
current=json.load(sys.stdin)
entries=current.get('meter',{}).get('priceSeed',{}).get('entries',[])
for entry in entries:
    for meter,value in entry['fields'].items():
        if float(value) != 0:
            entry['fields'][meter]='0.01'
json.dump({'meter':{'priceSeed':{'entries':entries}}},sys.stdout)
