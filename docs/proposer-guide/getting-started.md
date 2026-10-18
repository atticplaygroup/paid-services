# Proposer guide

## Before you start

Check if your application can be turned PAID:
- Does your data contain private information?
  - If yes, you'd better consider twice. Currently we do not provide a mechanism to protect data privacy.
- Is minute level write latency with eventual consistency acceptable?
  - Low latency applications like livestreaming is not supported yet.

## Prepare data for infrastructure

### Put your objects on a PAID object store

### Indexed data sync via hosting continuous backup

First ingest your data to a database, mysql or postgres. We support them for migration because they are robust. Then run our mysql-proposer chart, pointing to 

## Register in a router

### Registering your functionality

### Registering your workload

## Using other proposers' data

First ensure you are legal to use their data. Then it involves data cleaning, some ETL data pipeline, and transform to your database format. Do it your way. Just to mention you have the option to do it. And doing it well can provide a better experience for viewers and win you good reputation.
