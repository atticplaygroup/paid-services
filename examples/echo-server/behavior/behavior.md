# Echo behavior v1

POST /echo accepts a JSON object with a `message` string of at most 4096
characters. A successful response MUST be HTTP 200 and a JSON object containing
exactly the same `message`. Invalid messages MUST return HTTP 400.
