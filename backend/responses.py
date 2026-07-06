"""HTTP 响应工具。"""
import asyncio

STATUS_TEXT = {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    403: "Forbidden",
    404: "Not Found",
    413: "Payload Too Large",
    500: "Internal Server Error",
    503: "Service Unavailable",
}


async def send_response(writer: asyncio.StreamWriter, status: int, content_type: str, body: bytes):
    """发送 HTTP 响应。"""
    response = (
        f"HTTP/1.1 {status} {STATUS_TEXT.get(status, 'Unknown')}\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-cache, no-store\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    writer.write(response.encode() + body)
    await writer.drain()
