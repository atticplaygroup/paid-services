# OCI push and pull

The OCI flow involves four parties: a pusher, a puller, an OCI provider, and a storage provider. The pusher publishes content through its own OCI service; the puller retrieves it through the OCI provider.

- Pusher
  - Client POST/PUT -> Pusher OCI -> Pusher outproxy -> Storage provider
    - Pusher runs its own OCI because the converted write request to Kvstore must use its own outproxy for write access control
- Puller
  - Client GET -> Puller outproxy -> OCI provider
- OCI provider
  - Envoy -> Metered OCI service -> Outproxy -> Storage provider
    - Metered OCI service includes `applications/oci`, the resource-specific metering for OCI request converter
- Storage provider
  - Envoy -> Metered Storage service -> S3
    - Metered storage service includes `infrastructure/cmd/kvstore`, the resource-specific metering for storage

## Push

The pusher needs a funded account with the storage provider.
The client starts a blob upload with POST, then uploads the blob and manifest
with PUT. The pusher's OCI service converts these into Kvstore operations.

```mermaid
sequenceDiagram
    actor Client as Pusher client
    box Pusher
        participant PO as Pusher OCI
        participant PP as Pusher outproxy
    end
    box Storage provider
        participant SE as Storage Envoy
        participant SK as Metered Kvstore
        participant S3 as S3 storage
    end

    Client->>PO: POST /v2/{name}/blobs/uploads/
    PO-->>Client: 202 Accepted + upload location
    loop Blob upload and manifest publication
        Client->>PO: PUT blob or manifest
        PO->>PP: Kvstore write operations
        PP->>SE: HTTPS requests with the pusher's DPoP proof
        Note over SE: Check access through the meter authorization service
        SE->>SK: Forward write requests
        SK->>SK: Enforce Kvstore write access
        Note over SE,SK: Report request and storage usage for billing
        SK->>S3: Store blob content
        S3-->>SK: Stored
        SK-->>SE: Storage result
        SE-->>PP: Response
        PP-->>PO: Storage result
        PO-->>Client: 201 Created
    end
```

## Pull

The puller needs a funded account with the OCI provider. The OCI provider
needs a funded account with the storage provider and accesses storage using
its own identity.
The same route serves blob and manifest GET requests. The diagram shows a
blob read; manifest reads also resolve tag and anchor metadata in Kvstore.

```mermaid
sequenceDiagram
    actor Client as Puller client
    box Puller
        participant UP as Puller outproxy
    end
    box OCI provider
        participant OE as OCI Envoy
        participant OS as Metered OCI service
        participant OP as OCI outproxy
    end
    box Storage provider
        participant SE as Storage Envoy
        participant SK as Metered Kvstore
        participant S3 as S3 storage
    end

    Client->>UP: GET blob through HTTP proxy
    UP->>OE: HTTPS OCI request with the puller's DPoP proof
    Note over OE,OS: Check access and meter OCI usage
    OE->>OS: GET /v2/{name}/blobs/{digest}
    OS->>OP: Kvstore read operation
    OP->>SE: HTTPS request with the OCI provider's DPoP proof
    Note over SE,SK: Check access and meter storage usage
    SE->>SK: Forward read request
    SK->>S3: Read blob content
    S3-->>SK: Blob content
    SK-->>SE: Storage result
    SE-->>OP: Response
    OP-->>OS: Blob content
    OS-->>OE: 200 OK + blob
    OE-->>UP: 200 OK + blob
    UP-->>Client: 200 OK + blob
```

Alternatively, the puller can run its own OCI application or use an OCI library in its browser to access the storage provider directly. This avoids relying on a separate OCI provider and paying its metering charges, but requires the puller to manage the application and storage access.
