package utils

import (
	"encoding/hex"
	"fmt"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/dpop"
	"github.com/ipfs/go-cid"
	mh "github.com/multiformats/go-multihash"
)

// JWKJCSPublicKeyCodec identifies canonical public JWK JSON (RFC 8785).
const JWKJCSPublicKeyCodec uint64 = 0xeb51

func AuthzKey(thumb string) string {
	return fmt.Sprintf("u:%s", thumb)
}

func FormatPrincipal(publicKey any) (*cid.Cid, error) {
	thumb, err := dpop.ThumbprintBytes(publicKey)
	if err != nil {
		return nil, err
	}
	return PrincipalFromThumbprint(thumb)
}

// PrincipalFromThumbprint encodes an RFC 7638 SHA-256 public JWK thumbprint.
func PrincipalFromThumbprint(digest []byte) (*cid.Cid, error) {
	return digestToCID(digest, JWKJCSPublicKeyCodec)
}

// DigestToMultihash encodes raw content, not an account principal.
func DigestToMultihash(digest []byte) (*cid.Cid, error) {
	return digestToCID(digest, cid.Raw)
}

func digestToCID(digest []byte, codec uint64) (*cid.Cid, error) {
	if len(digest) != 32 {
		return &cid.Undef, fmt.Errorf("expected sha256 digest (32 bytes), got %d", len(digest))
	}
	buf, err := mh.Encode(digest, mh.SHA2_256)
	if err != nil {
		return &cid.Undef, err
	}
	ret := cid.NewCidV1(codec, mh.Multihash(buf))
	return &ret, nil
}

func FormatName(key string) string {
	return fmt.Sprintf("value/%s", key)
}

func FormatProtectedName(owner, key string) string {
	return fmt.Sprintf("user/%s/value/%s", owner, key)
}

func FormatProtectedMetadataName(owner, key string) string {
	return fmt.Sprintf("user/%s/value/%s/md", owner, key)
}

func FormatProtectedAnchorName(owner, key string) string {
	return fmt.Sprintf("user/%s/anchor/%s", owner, key)
}

func HexToBytes32(hexStr string) ([]byte, error) {
	if byteSlice, err := hexToBytes(hexStr, 32); err != nil {
		return nil, err
	} else {
		return byteSlice, nil
	}
}

func hexToBytes(hexStr string, arrayLength uint8) ([]byte, error) {
	if (len(hexStr) != 2*int(arrayLength)+2) || hexStr[:2] != "0x" {
		return nil, fmt.Errorf(
			"expected hex string for 32 bytes beginning with 0x but got %s", hexStr,
		)
	}

	byteSlice, err := hex.DecodeString(hexStr[2:])
	if err != nil {
		return nil, err
	}
	return byteSlice, nil
}

func ConcatBytes(byteSlices ...[]byte) []byte {
	var result []byte
	for _, b := range byteSlices {
		result = append(result, b...)
	}
	return result
}
