# Generate a simple icon PNG
import struct
import zlib

def create_png(size, bg_color, text_color):
    width = height = size
    
    # Create pixel data - dark blue background with white "S"
    pixels = []
    for y in range(height):
        row = []
        for x in range(width):
            # Simple circle background
            cx, cy = width/2, height/2
            r = width * 0.45
            if (x-cx)**2 + (y-cy)**2 <= r**2:
                row.extend(bg_color)
            else:
                row.extend([0, 0, 0, 0])
        pixels.append(row)
    
    # PNG header
    png_header = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = make_chunk(b'IHDR', ihdr_data)
    
    # IDAT chunk
    raw_data = b''
    for row in pixels:
        raw_data += b'\x00' + bytes(row)
    compressed = zlib.compress(raw_data)
    idat = make_chunk(b'IDAT', compressed)
    
    # IEND chunk
    iend = make_chunk(b'IEND', b'')
    
    return png_header + ihdr + idat + iend

def make_chunk(chunk_type, data):
    chunk = chunk_type + data
    return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)

# Create a simple 48x48 icon with RGBA
size = 48
width = height = size
pixels = []
bg = [31, 78, 121, 255]  # #1F4E79 blue
for y in range(height):
    row = []
    for x in range(width):
        cx, cy = width/2, height/2
        r = width * 0.45
        if (x-cx)**2 + (y-cy)**2 <= r**2:
            row.extend(bg)
        else:
            row.extend([0, 0, 0, 0])
    pixels.append(row)

png_header = b'\x89PNG\r\n\x1a\n'

def make_chunk2(chunk_type, data):
    crc = zlib.crc32(chunk_type + data) & 0xffffffff
    return struct.pack('>I', len(data)) + chunk_type + data + struct.pack('>I', crc)

ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # RGBA
ihdr = make_chunk2(b'IHDR', ihdr_data)

raw_data = b''
for row in pixels:
    raw_data += b'\x00' + bytes(row)
compressed = zlib.compress(raw_data)
idat = make_chunk2(b'IDAT', compressed)
iend = make_chunk2(b'IEND', b'')

with open('/home/claude/linkedin-scout/icon.png', 'wb') as f:
    f.write(png_header + ihdr + idat + iend)

print("Icon created")
