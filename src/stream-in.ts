/**
 * A class for reading binary data from a Buffer
 */
export default class StreamIn {
	private buffer: Buffer;
	public pos: number;

	/**
	 * Creates a new StreamIn instance
	 * @param buffer - The buffer to read from
	 */
	constructor(buffer: Buffer) {
		this.buffer = buffer;
		this.pos = 0;
	}

	/**
	 * Checks if there is more data to read
	 * @returns true if there is more data to read, false otherwise
	 */
	public hasData(): boolean {
		return this.pos < this.buffer.length;
	}

	/**
	 * Gets the total size of the buffer
	 * @returns The total size of the buffer in bytes
	 */
	public size(): number {
		return this.buffer.length;
	}

	/**
	 * Skips the specified number of bytes
	 * @param length - Number of bytes to skip
	 */
	public skip(length: number): void {
		this.pos += length;
	}

	/**
	 * Sets the current read position
	 * @param pos - The new read position
	 */
	public seek(pos: number): void {
		this.pos = pos;
	}

	/**
	 * Reads the specified number of bytes
	 * @param length - Number of bytes to read
	 * @returns A new Buffer containing the read bytes
	 */
	public readBytes(length: number): Buffer {
		const read = this.buffer.subarray(this.pos, this.pos + length);
		this.pos += length;

		return read;
	}

	/**
	 * Reads an unsigned 8-bit integer
	 * @returns The read value
	 */
	public readUint8(): number {
		return this.readBytes(1).readUint8();
	}

	/**
	 * Reads an unsigned 16-bit integer in little-endian format
	 * @returns The read value
	 */
	public readUint16LE(): number {
		return this.readBytes(2).readUint16LE();
	}

	/**
	 * Reads an unsigned 32-bit integer in little-endian format
	 * @returns The read value
	 */
	public readUint32LE(): number {
		return this.readBytes(4).readUint32LE();
	}

	/**
	 * Reads a signed 32-bit integer in little-endian format
	 * @returns The read value
	 */
	public readInt32LE(): number {
		return this.readBytes(4).readInt32LE();
	}

	/**
	 * Reads an unsigned 16-bit integer in big-endian format
	 * @returns The read value
	 */
	public readUint16BE(): number {
		return this.readBytes(2).readUint16BE();
	}

	/**
	 * Reads an unsigned 32-bit integer in big-endian format
	 * @returns The read value
	 */
	public readUint32BE(): number {
		return this.readBytes(4).readUint32BE();
	}
}
