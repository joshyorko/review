package review

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

func marshalCanonicalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(canonicalJSONValue(value)); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2028`), []byte("\u2028"))
	encoded = bytes.ReplaceAll(encoded, []byte(`\u2029`), []byte("\u2029"))
	return encoded, nil
}

type pythonFloat float64

func (value pythonFloat) MarshalJSON() ([]byte, error) {
	number := float64(value)
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return nil, strconv.ErrSyntax
	}
	formatted := strconv.FormatFloat(number, 'g', -1, 64)
	if !strings.ContainsAny(formatted, ".eE") {
		formatted += ".0"
	}
	return []byte(formatted), nil
}

func canonicalJSONValue(value any) any {
	switch typed := value.(type) {
	case float32:
		return pythonFloat(typed)
	case float64:
		return pythonFloat(typed)
	case json.Number:
		if string(typed) == "-0" {
			return json.Number("0")
		}
		if !isJSONInteger(string(typed)) {
			if number, err := strconv.ParseFloat(string(typed), 64); err == nil {
				return pythonFloat(number)
			}
		}
		return typed
	case map[string]any:
		return canonicalStringMap(typed)
	case map[string]map[string]any:
		normalized := make(map[string]map[string]any, len(typed))
		for key, item := range typed {
			normalized[key] = canonicalStringMap(item)
		}
		return normalized
	case []any:
		normalized := make([]any, len(typed))
		for index, item := range typed {
			normalized[index] = canonicalJSONValue(item)
		}
		return normalized
	case []map[string]any:
		normalized := make([]any, len(typed))
		for index, item := range typed {
			normalized[index] = canonicalJSONValue(item)
		}
		return normalized
	default:
		return value
	}
}

func canonicalStringMap(value map[string]any) map[string]any {
	normalized := make(map[string]any, len(value))
	for key, item := range value {
		normalized[key] = canonicalJSONValue(item)
	}
	return normalized
}
