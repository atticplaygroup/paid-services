"""Build meter-chart values for the fixture's generated request paths."""
import json
import sys

fixture = json.load(open(sys.argv[1]))
values = json.load(sys.stdin)
party = sys.argv[2]
files = [f'/v2/{fixture["collection"]["owner"]}/{fixture["collection"]["name"]}/blobs/{layer["digest"]}' for layer in fixture['layers']]
if party == 'index':
    paths = ['/index.v1.IndexService/Advertise', '/index.v1.IndexService/SearchProvider', '/echo']
    ports = [(8080, '')]
elif party == 'oci-provider':
    paths = files + [f'/v2/{d["maintainer"]}/{d["name"]}/manifests/{d["tag"]}' for d in fixture['functionality'].values()]
    ports = [(8443, ''), (8443, 'oci-provider-envoy.oci-provider-ns.svc.cluster.local')]
else:
    paths = ['/kvstore.v1.MeteredStorageService/' + rpc for rpc in ['GetCASValue', 'GetProtectedValueAnchor']]
    ports = [(8080, ''), (8443, ''), (8443, 'storage-provider-envoy.storage-provider-ns.svc.cluster.local')]
entries = values.get('meter', {}).get('priceSeed', {}).get('entries', [])
for port, sni in ports:
    for path in paths:
        entries.append({'key': f'p:{sni}:{port}:{path}', 'fields': {'METER_TYPE_DURATION_MS': '1', 'METER_TYPE_INGRESS_BYTES': '1', 'METER_TYPE_EGRESS_BYTES': '1'}})
json.dump({'meter': {'priceSeed': {'entries': entries}}}, sys.stdout)
