"""Host-only contract tests for B2. Expected values come from input construction."""
import pytest
from werkzeug.sansio.multipart import MultipartDecoder, Data, Field, File, NeedData, Epilogue

PAYLOADS = [b"", b"x", b"\r", b"\n", b"\r\n", b"\r\nbody\r\n",
            b"a\r\r", b"a\n\n", b"\x00\xff\r\n\x00", bytes(range(256))]

def encode(payload, newline=b"\r\n", boundary=b"contract-boundary-23"):
    empty = (b"--" + boundary + newline + b'Content-Disposition: form-data; name="empty"'
             + newline * 2 + newline)
    upload = (b"--" + boundary + newline + b'Content-Disposition: form-data; name="upload"; filename="x.bin"'
              + newline * 2 + payload + newline)
    return empty + upload + b"--" + boundary + b"--" + newline

def decode(chunks, boundary=b"contract-boundary-23", memory_limit=None):
    decoder = MultipartDecoder(boundary, max_form_memory_size=memory_limit)
    values, current, before_eof, peak = {}, None, 0, 0
    for chunk in [*chunks, None]:
        decoder.receive_data(chunk)
        peak = max(peak, len(decoder.buffer))
        for _ in range(1000):
            event = decoder.next_event()
            if isinstance(event, (Field, File)):
                current = event.name
                assert current not in values, "Duplicate part event"
                values[current] = b""
            elif isinstance(event, Data):
                assert current is not None
                values[current] += event.data
                if chunk is not None:
                    before_eof += len(event.data)
            if isinstance(event, (NeedData, Epilogue)):
                break
        else:
            raise AssertionError("Decoder did not yield")
    return values, before_eof, peak

@pytest.mark.parametrize("payload", PAYLOADS)
@pytest.mark.parametrize("newline", [b"\r\n"])
@pytest.mark.parametrize("width", [1, 2, 3, 7, 17, 64, 1024])
def test_partition_preserves_bytes(payload, newline, width):
    body = encode(payload, newline)
    chunks = [body[i:i+width] for i in range(0, len(body), width)]
    assert decode(chunks)[0] == {"empty": b"", "upload": payload}

@pytest.mark.parametrize("payload", [b"", b"\r\n", b"\x00data\r\r"])
def test_every_single_cut(payload):
    body = encode(payload)
    for cut in range(1, len(body)):
        assert decode([body[:cut], body[cut:]])[0] == {"empty": b"", "upload": payload}, cut

def test_streaming_progress_without_buffering_entire_body():
    payload = bytes(range(256)) * 512
    body = encode(payload)
    chunks = [body[i:i+97] for i in range(0, len(body), 97)]
    values, emitted_before_eof, peak = decode(chunks, memory_limit=8192)
    assert values == {"empty": b"", "upload": payload}
    assert emitted_before_eof >= len(payload) - 128
    assert peak < 8192
