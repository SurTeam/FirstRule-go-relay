package agent

import (
	"bytes"
	"encoding/json"
)

func (h *headerMap) UnmarshalJSON(data []byte) error {
	*h = headerMap{}
	if bytes.Equal(data, []byte("null")) {
		return nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	out := headerMap{}
	for k, v := range raw {
		var many []string
		if err := json.Unmarshal(v, &many); err == nil {
			out[k] = many
			continue
		}
		var one string
		if err := json.Unmarshal(v, &one); err != nil {
			return err
		}
		out[k] = []string{one}
	}
	*h = out
	return nil
}
