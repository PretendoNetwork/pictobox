/**
 * A class for writing binary data to a Buffer
 */
export default class StreamOut {
	private buffer: Buffer;
	public pos: number;

	/**
	 * Creates a new StreamOut instance with an empty buffer
	 */
	constructor(size?: number) {
		this.buffer = Buffer.alloc(size || 0);
		this.pos = 0;
	}

	/**
	 * Ensures the buffer has enough capacity for the given length
	 * @param length - Number of bytes needed
	 */
	private ensureCapacity(length: number): void {
		const needed = this.pos + length;

		if (needed > this.buffer.length) {
			// * Give the buffer some extra room when growing. This takes up a bit more
			// * memory, but reduces the overall number of capacity increases
			const newSize = Math.max(needed, Math.floor(this.buffer.length * 1.5));
			this.grow(newSize);
		}
	}

	/**
	 * Expands the buffers size by the given number of bytes
	 * @param length - Number of bytes to expand by
	 */
	public grow(length: number): void {
		const newBuffer = Buffer.alloc(length);

		this.buffer.copy(newBuffer);
		this.buffer = newBuffer;
	}

	/**
	 * Gets the current buffer (trimmed to actual written size)
	 * @returns The buffer containing written data
	 */
	public bytes(): Buffer {
		return this.buffer.subarray(0, this.pos);
	}

	/**
	 * Gets the total size of the buffer
	 * @returns The total size of the buffer in bytes
	 */
	public size(): number {
		return this.buffer.length;
	}

	/**
	 * Skips the specified number of bytes by writing zeros
	 * @param length - Number of bytes to skip
	 */
	public skip(length: number): void {
		this.ensureCapacity(length);
		this.buffer.fill(0, this.pos, this.pos + length);
		this.pos += length;
	}

	/**
	 * Sets the current write position
	 * @param pos - The new write position
	 */
	public seek(pos: number): void {
		this.pos = pos;
	}

	/**
	 * Writes bytes to the buffer
	 * @param bytes - The bytes to write
	 */
	public writeBytes(bytes: Buffer): void {
		this.ensureCapacity(bytes.length);
		bytes.copy(this.buffer, this.pos);
		this.pos += bytes.length;
	}

	/**
	 * Writes an unsigned 8-bit integer
	 * @param uint8 - The value to write
	 */
	public writeUint8(uint8: number): void {
		this.ensureCapacity(1);
		this.buffer.writeUint8(uint8, this.pos);
		this.pos += 1;
	}

	/**
	 * Writes an unsigned 16-bit integer in little-endian format
	 * @param uint16 - The value to write
	 */
	public writeUint16LE(uint16: number): void {
		this.ensureCapacity(2);
		this.buffer.writeUint16LE(uint16, this.pos);
		this.pos += 2;
	}

	/**
	 * Writes an unsigned 32-bit integer in little-endian format
	 * @param uint32 - The value to write
	 */
	public writeUint32LE(uint32: number): void {
		this.ensureCapacity(4);
		this.buffer.writeUint32LE(uint32, this.pos);
		this.pos += 4;
	}

	/**
	 * Writes a signed 32-bit integer in little-endian format
	 * @param int32 - The value to write
	 */
	public writeInt32LE(int32: number): void {
		this.ensureCapacity(4);
		this.buffer.writeInt32LE(int32, this.pos);
		this.pos += 4;
	}

	/**
	 * Writes an unsigned 16-bit integer in big-endian format
	 * @param uint16 - The value to write
	 */
	public writeUint16BE(uint16: number): void {
		this.ensureCapacity(2);
		this.buffer.writeUint16BE(uint16, this.pos);
		this.pos += 2;
	}

	/**
	 * Writes an unsigned 32-bit integer in big-endian format
	 * @param uint32 - The value to write
	 */
	public writeUint32BE(uint32: number): void {
		this.ensureCapacity(4);
		this.buffer.writeUint32BE(uint32, this.pos);
		this.pos += 4;
	}
}
