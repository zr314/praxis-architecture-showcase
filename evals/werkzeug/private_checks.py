"""Host-only byte-preservation checks. Never copied into a model workspace."""
import io
import pytest
from werkzeug.wrappers import Request
from werkzeug.sansio.multipart import MultipartDecoder, Data, Field, File, NeedData, Epilogue

PAYLOADS = [b'', b'x', b'\r', b'\n', b'\r\n', b'\r\ncontent\r\n', b'\0\xff\r\n\0',
            b'abc\r', b'abc\r\r', b'--almost-boundary\r\nend', bytes(range(256))]

def encoded(payload, boundary, multiple):
    header = b'--' + boundary + b'\r\nContent-Disposition: form-data; name="upload"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'
    trailer = b'\r\n--' + boundary + b'--\r\n'
    prefix = (b'--' + boundary + b'\r\nContent-Disposition: form-data; name="empty"\r\n\r\n\r\n') if multiple else b''
    return prefix + header + payload + trailer, len(prefix + header)

@pytest.mark.parametrize('payload', PAYLOADS)
@pytest.mark.parametrize('multiple', [False, True])
@pytest.mark.parametrize('offset', [-2, -1, 0, 1, 2, None])
def test_request_bytes(payload, multiple, offset):
    boundary = b'private-independent-boundary'
    body, head_end = encoded(payload, boundary, multiple)
    class Fragmented(io.BytesIO):
        def readinto(self, buffer):
            if offset is not None and self.tell() == 0:
                buffer = memoryview(buffer)[:head_end + offset]
            return super().readinto(buffer)
    with Request.from_values(method='POST', input_stream=Fragmented(body), content_length=len(body),
                             content_type='multipart/form-data; boundary=' + boundary.decode()) as request:
        assert request.files['upload'].read() == payload
        if multiple:
            assert request.form['empty'] == ''

@pytest.mark.parametrize('payload', PAYLOADS)
@pytest.mark.parametrize('style', ['seven', 'header-end', 'boundary-split'])
def test_decoder_partitions(payload, style):
    # Pre-model scope decision: even official 3.1.7 fails one-byte partitions and
    # seven-byte partitions of this empty file. Retain those observations in the
    # broad preflight artifact, but do not require unrelated fixes for issue B.
    if style == 'seven' and payload == b'':
        pytest.skip('Known failure in the official reference release, outside this repair')
    boundary = b'independent-abc123'
    body, head_end = encoded(payload, boundary, True)
    if style == 'header-end':
        chunks = [body[:head_end], body[head_end:]]
    elif style == 'boundary-split':
        cut = len(body) - len(boundary) - 5
        chunks = [body[:cut], body[cut:cut+4], body[cut+4:]]
    else:
        width = 7
        chunks = [body[i:i+width] for i in range(0, len(body), width)]
    decoder = MultipartDecoder(boundary)
    values = {}
    current = None
    for chunk in [*chunks, None]:
        decoder.receive_data(chunk)
        for _ in range(1000):
            event = decoder.next_event()
            if isinstance(event, (File, Field)):
                current = event.name
                values[current] = b''
            elif isinstance(event, Data):
                values[current] += event.data
            if isinstance(event, (NeedData, Epilogue)):
                break
        else:
            raise AssertionError('Decoder failed to yield')
    assert values == {'empty': b'', 'upload': payload}

@pytest.mark.parametrize('count', [1, 2, 3])
@pytest.mark.parametrize('size', [65534, 65535, 65536, 131071])
def test_historical_trailing_cr(size, count):
    payload = b'\0' * size + b'\r' * count
    with Request.from_values(data={'upload': (io.BytesIO(payload), 'x.bin')}, method='POST') as request:
        assert request.files['upload'].read() == payload
