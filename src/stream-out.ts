export default class StreamOut {
	private buffer: Buffer;
	public pos: number;

	constructor() {
		this.buffer = Buffer.alloc(0);
		this.pos = 0;
	}

	public bytes(): Buffer {
		return this.buffer;
	}

	public size(): number {
		return this.buffer.length;
	}

	public skip(length: number): void {
		this.writeBytes(Buffer.alloc(length));
	}

	public seek(pos: number): void {
		this.pos = pos;
	}

	public writeBytes(bytes: Buffer): void {
		const before = this.buffer.subarray(0, this.pos);
		const after = this.buffer.subarray(this.pos);

		this.buffer = Buffer.concat([
			before,
			bytes,
			after
		]);

		this.pos += bytes.length;
	}

	public writeUint8(uint8: number): void {
		const bytes = Buffer.alloc(1);

		bytes.writeUint8(uint8);

		this.writeBytes(bytes);
	}

	public writeUint16LE(uint16: number): void {
		const bytes = Buffer.alloc(2);

		bytes.writeUint16LE(uint16);

		this.writeBytes(bytes);
	}

	public writeUint32LE(uint32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeUint32LE(uint32);

		this.writeBytes(bytes);
	}

	public writeInt32LE(int32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeInt32LE(int32);

		this.writeBytes(bytes);
	}

	public writeUint16BE(uint16: number): void {
		const bytes = Buffer.alloc(2);

		bytes.writeUint16BE(uint16);

		this.writeBytes(bytes);
	}

	public writeUint32BE(uint32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeUint32BE(uint32);

		this.writeBytes(bytes);
	}
}