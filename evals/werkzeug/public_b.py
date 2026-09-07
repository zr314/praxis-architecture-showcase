"""User reproduction: upload bytes differ depending on how the input stream is read."""
import io
from werkzeug.wrappers import Request

boundary = b'user-upload-boundary'
header = b'--' + boundary + b'\r\nContent-Disposition: form-data; name="upload"; filename="file.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'
expected = b'\x00\x00\x00\x18test-media-data'
body = header + expected + b'\r\n--' + boundary + b'--\r\n'

class Fragmented(io.BytesIO):
    def readinto(self, buffer):
        if self.tell() == 0:
            buffer = memoryview(buffer)[:len(header)]
        return super().readinto(buffer)

for stream in (io.BytesIO(body), Fragmented(body)):
    with Request.from_values(method='POST', input_stream=stream, content_length=len(body),
                             content_type='multipart/form-data; boundary=' + boundary.decode()) as request:
        actual = request.files['upload'].read()
    print(f'{type(stream).__name__}: expected={len(expected)}, actual={len(actual)}, prefix={actual[:6].hex()}')
    assert actual == expected
