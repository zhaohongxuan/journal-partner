export type ShareTemplate = 'paper' | 'calendar' | 'night';

export interface ShareCardOptions {
	template: ShareTemplate;
	showDate: boolean;
	showTags: boolean;
	showAuthor: boolean;
	author: string;
}

export type ShareBlock = { type: 'text'; text: string } | { type: 'image'; image: HTMLImageElement };

export interface ShareCardContent {
	blocks: ShareBlock[];
	tags: string[];
	/** Calendar date in YYYY-MM-DD format. */
	date: string;
	timestamp: string;
	title: string;
	subtitle: string;
	weekday: string;
	month: string;
	task?: boolean;
	completed?: boolean;
	taskLabel?: string;
}

const WIDTH = 390;
const SCALE = 2;
const PADDING = 32;
const INNER_WIDTH = WIDTH - PADDING * 2;
const MAX_HEIGHT = 30000 / SCALE;
const SERIF = '"Songti SC", "Noto Serif CJK SC", "Noto Serif SC", Georgia, serif';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
const TOO_TALL = 'This entry is too long to create a share card safely. Please share a shorter selection (the image would exceed 30,000 pixels in height).';

type Draw = (ctx: CanvasRenderingContext2D) => void;

/**
 * Wrap plain text at Latin word boundaries and between CJK characters.
 * Explicit newlines (including empty paragraphs) are preserved. Oversized
 * words are split by Unicode code point, with every iteration consuming input.
 */
export function wrapShareText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
		throw new Error('Share card text needs a positive, finite wrapping width.');
	}
	const result: string[] = [];
	for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
		// Keep Latin words together; CJK ideographs, kana and hangul can wrap individually.
		const tokens = paragraph.match(/[\t ]+|[^\s\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{323af}]+|[\s\S]/gu) || [];
		let line = '';
		for (const token of tokens) {
			if (/^[\t ]+$/.test(token)) {
				if (line) line += token.replace(/\t/g, '    ');
				continue;
			}
			if (ctx.measureText(line + token).width <= maxWidth) {
				line += token;
				continue;
			}
			if (line.replace(/\s+$/, '')) {
				result.push(line.replace(/\s+$/, ''));
				line = '';
			}
			if (ctx.measureText(token).width <= maxWidth) {
				line = token;
				continue;
			}
			const chars = Array.from(token);
			let start = 0;
			while (start < chars.length) {
				let low = 1;
				const remaining = chars.length - start;
				let high = 1;
				while (high < remaining && ctx.measureText(chars.slice(start, start + high).join('')).width <= maxWidth) {
					high = Math.min(remaining, high * 2);
				}
				let fitting = 0;
				while (low <= high) {
					const count = Math.floor((low + high) / 2);
					if (ctx.measureText(chars.slice(start, start + count).join('')).width <= maxWidth) {
						fitting = count;
						low = count + 1;
					} else {
						high = count - 1;
					}
				}
				// A glyph can itself exceed an unusually narrow caller-supplied width.
				const count = Math.max(1, fitting);
				const part = chars.slice(start, start + count).join('');
				start += count;
				if (start < chars.length) result.push(part);
				else line = part;
			}
		}
		result.push(line.replace(/\s+$/, ''));
	}
	return result;
}

/** Render the very same 2x canvas used for both preview and image export. */
export function renderShareCard(canvas: HTMLCanvasElement, content: ShareCardContent, options: ShareCardOptions): void {
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Your device could not create a canvas for this share card.');

	const night = options.template === 'night';
	const calendar = options.template === 'calendar';
	const background = night ? '#243c32' : calendar ? '#fffef9' : '#f8f5ed';
	const ink = night ? '#f0eee2' : '#3b4037';
	const muted = night ? '#b1bdab' : '#8b907f';
	const accent = night ? '#b6c79d' : '#6f8059';
	const rule = night ? '#506254' : '#dddfd2';
	const draws: Draw[] = [];
	let y = 32;

	const checkHeight = (height: number): void => {
		if (!Number.isFinite(height) || height > MAX_HEIGHT) throw new Error(TOO_TALL);
	};
	const text = (value: string, x: number, top: number, width: number, font: string, color: string, lineHeight: number): number => {
		ctx.font = font;
		const lines = wrapShareText(ctx, value, width);
		const height = lines.length * lineHeight;
		checkHeight(top + height + PADDING);
		draws.push((target) => {
			target.font = font;
			target.fillStyle = color;
			lines.forEach((line, index) => target.fillText(line, x, top + index * lineHeight));
		});
		return height;
	};
	const horizontalRule = (top: number, color = rule): void => {
		draws.push((target) => {
			target.fillStyle = color;
			target.fillRect(PADDING, top, INNER_WIDTH, 1);
		});
	};

	if (calendar) {
		draws.push((target) => {
			target.fillStyle = accent;
			target.fillRect(0, 0, WIDTH, 5);
		});
	}
	const brand = 'JOURNAL PARTNER';
	ctx.font = `9px ${SANS}`;
	const brandWidth = ctx.measureText(brand).width;
	const titleHeight = content.title ? text(content.title, PADDING, y, INNER_WIDTH - brandWidth - 20, `${calendar ? 15 : night ? 16 : 21}px ${SERIF}`, ink, 26) : 26;
	text(brand, WIDTH - PADDING - brandWidth, y + 2, brandWidth + 1, `9px ${SANS}`, muted, 14);
	y += Math.max(titleHeight, 19) + (calendar ? 26 : 30);

	if (calendar && options.showDate) {
		const day = content.date.split('-')[2] || content.date;
		const dayHeight = text(day, PADDING, y, 116, `64px ${SERIF}`, ink, 76);
		const details = [content.month, [content.weekday, content.timestamp].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
		const detailHeight = details ? text(details, PADDING + 130, y + 17, INNER_WIDTH - 130, `12px ${SANS}`, muted, 22) + 17 : 0;
		y += Math.max(dayHeight, detailHeight) + 20;
		horizontalRule(y);
		y += 28;
	} else if (!calendar) {
		text('“', PADDING - 2, y, INNER_WIDTH, `60px ${SERIF}`, accent, 55);
		y += 56;
	}

	if (content.task) {
		const top = y + 2;
		draws.push((target) => {
			target.strokeStyle = accent;
			target.lineWidth = 1.5;
			target.strokeRect(PADDING + 1, top, 15, 15);
			if (content.completed) {
				target.beginPath();
				target.moveTo(PADDING + 4, top + 7);
				target.lineTo(PADDING + 7, top + 11);
				target.lineTo(PADDING + 13, top + 4);
				target.stroke();
			}
		});
		text(content.taskLabel || (content.completed ? 'Completed task' : 'Task'), PADDING + 26, y, INNER_WIDTH - 26, `12px ${SANS}`, muted, 21);
		y += 35;
	}

	const bodyFont = `${night ? 23 : 21}px ${SERIF}`;
	const bodyLineHeight = night ? 41 : 38;
	for (let index = 0; index < content.blocks.length; index++) {
		const block = content.blocks[index];
		if (index > 0) y += 18;
		if (block.type === 'text') {
			y += text(block.text, PADDING, y, INNER_WIDTH, bodyFont, ink, bodyLineHeight);
		} else {
			const image = block.image;
			const naturalWidth = image.naturalWidth;
			const naturalHeight = image.naturalHeight;
			if (!naturalWidth || !naturalHeight) {
				throw new Error('An image in this entry has not finished loading. Please wait and try creating the share card again.');
			}
			const scale = Math.min(1, INNER_WIDTH / naturalWidth, 360 / naturalHeight);
			const width = naturalWidth * scale;
			const height = naturalHeight * scale;
			checkHeight(y + height + PADDING);
			const imageY = y;
			draws.push((target) => target.drawImage(image, (WIDTH - width) / 2, imageY, width, height));
			y += height;
		}
	}

	if (options.showTags && content.tags.length) {
		y += 25;
		const tags = content.tags.map((tag) => tag.startsWith('#') ? tag : `#${tag}`).join('   ');
		y += text(tags, PADDING, y, INNER_WIDTH, `12px ${SANS}`, accent, 22);
	}

	const hasAuthor = options.showAuthor && Boolean(options.author.trim());
	const hasDate = options.showDate && Boolean(content.date || content.timestamp);
	if (hasAuthor || hasDate) {
		y += 30;
		const footerRuleY = y;
		const footerTop = y + 23;
		const dateWidth = hasAuthor ? 104 : INNER_WIDTH;
		const authorWidth = hasDate ? INNER_WIDTH - dateWidth - 22 : INNER_WIDTH;
		let authorHeight = 0;
		let dateHeight = 0;
		// Measure the complete footer before deciding how much minimum-height space to add.
		const footerStart = draws.length;
		if (hasAuthor) {
			authorHeight = text(options.author, PADDING, footerTop, authorWidth, `13px ${SANS}`, ink, 21);
			if (content.subtitle) {
				authorHeight += 5 + text(content.subtitle, PADDING, footerTop + authorHeight + 5, authorWidth, `10px ${SANS}`, muted, 17);
			}
		}
		if (hasDate) {
			const stamp = [content.date.replace(/-/g, '.'), content.timestamp].filter(Boolean).join('\n');
			dateHeight = text(stamp, WIDTH - PADDING - dateWidth, footerTop, dateWidth, `11px ${SANS}`, muted, 19);
		}
		const footerHeight = Math.max(authorHeight, dateHeight);
		const extraSpace = Math.max(0, 480 - (footerTop + footerHeight + PADDING));
		const footerDraws = draws.splice(footerStart);
		if (calendar) horizontalRule(footerRuleY + extraSpace);
		draws.push((target) => {
			target.save();
			target.translate(0, extraSpace);
			footerDraws.forEach((draw) => draw(target));
			target.restore();
		});
		y = footerTop + extraSpace + footerHeight;
	}

	const height = Math.ceil(Math.max(480, y + PADDING));
	checkHeight(height);
	// Resizing resets all canvas state. Avoid measuring against inherited transforms.
	canvas.width = WIDTH * SCALE;
	canvas.height = height * SCALE;
	ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
	ctx.textBaseline = 'top';
	ctx.textAlign = 'left';
	ctx.direction = 'ltr';
	ctx.fillStyle = background;
	ctx.fillRect(0, 0, WIDTH, height);
	try {
		draws.forEach((draw) => draw(ctx));
	} catch (error) {
		throw new Error(`The share card could not be drawn. Please try again. ${error instanceof Error ? error.message : String(error)}`);
	}
}
