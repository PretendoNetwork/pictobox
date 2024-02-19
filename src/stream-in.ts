// TODO - TSDoc comments

export default class StreamIn {
	private buffer: Buffer;
	public pos: number;

	constructor(buffer: Buffer) {
		this.buffer = buffer;
		this.pos = 0;
	}

	public hasData(): boolean {
		return this.pos < this.buffer.length;
	}

	public size(): number {
		return this.buffer.length;
	}

	public skip(length: number): void {
		this.pos += length;
	}

	public seek(pos: number): void {
		this.pos = pos;
	}

	public readBytes(length: number): Buffer {
		const read = this.buffer.subarray(this.pos, this.pos+length);
		this.pos += length;

		return read;
	}

	public readUint8(): number {
		return this.readBytes(1).readUint8();
	}

	public readUint16LE(): number {
		return this.readBytes(2).readUint16LE();
	}

	public readUint32LE(): number {
		return this.readBytes(4).readUint32LE();
	}

	public readInt32LE(): number {
		return this.readBytes(4).readInt32LE();
	}

	public readUint16BE(): number {
		return this.readBytes(2).readUint16BE();
	}

	public readUint32BE(): number {
		return this.readBytes(4).readUint32BE();
	}
}