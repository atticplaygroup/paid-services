-- name: PutAdvertisement :exec
INSERT INTO advertisements (id, functionality, publisher, advertisement, ingress_time)
VALUES (?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE advertisement = VALUES(advertisement), ingress_time = VALUES(ingress_time);

-- name: SearchAdvertisements :many
SELECT id, advertisement, ingress_time FROM advertisements
WHERE functionality = ?
ORDER BY ingress_time DESC, id ASC
LIMIT ? OFFSET ?;
