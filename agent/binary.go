package agent

import "fmt"

// EncodeBinary builds a protocol-2 frame: [kind u8][idLen u8][id][payload].
func EncodeBinary(kind byte, id string, payload []byte) ([]byte, error) {
	idBytes := []byte(id)
	if len(idBytes) > 255 {
		return nil, fmt.Errorf("frame id too long")
	}
	out := make([]byte, 2+len(idBytes)+len(payload))
	out[0] = kind
	out[1] = byte(len(idBytes))
	copy(out[2:], idBytes)
	copy(out[2+len(idBytes):], payload)
	return out, nil
}

// DecodeBinary parses a protocol-2 frame.
func DecodeBinary(frame []byte) (kind byte, id string, data []byte, err error) {
	if len(frame) < 2 {
		return 0, "", nil, fmt.Errorf("frame too short")
	}
	idLen := int(frame[1])
	if len(frame) < 2+idLen {
		return 0, "", nil, fmt.Errorf("frame truncated")
	}
	return frame[0], string(frame[2 : 2+idLen]), frame[2+idLen:], nil
}
