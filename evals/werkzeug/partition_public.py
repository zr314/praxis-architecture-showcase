"""User reproduction for the follow-up task; ordinary in-memory parsing only."""
from werkzeug.sansio.multipart import MultipartDecoder, Data, Field, File, NeedData, Epilogue

boundary = b"sample-partition"
body = (b'--sample-partition\r\nContent-Disposition: form-data; name="empty"\r\n\r\n'
        b'\r\n--sample-partition\r\nContent-Disposition: form-data; name="upload"; filename="x.bin"\r\n\r\n'
        b'hello\r\n--sample-partition--\r\n')

def parse(chunks):
    decoder = MultipartDecoder(boundary)
    values, current = {}, None
    for chunk in [*chunks, None]:
        decoder.receive_data(chunk)
        for _ in range(1000):
            event = decoder.next_event()
            if isinstance(event, (Field, File)):
                current = event.name
                values[current] = b""
            elif isinstance(event, Data):
                values[current] += event.data
            if isinstance(event, (NeedData, Epilogue)):
                break
        else:
            raise AssertionError("Decoder did not yield")
    return values

if __name__ == "__main__":
    whole = parse([body])
    fragmented = parse([body[i:i+1] for i in range(len(body))])
    print("whole:", whole)
    print("one byte at a time:", fragmented)
    assert whole == {"empty": b"", "upload": b"hello"}
    assert fragmented == whole
