const MAX_PDF_SIZE_MB = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pdf_base64 } = req.body;
  if (!pdf_base64) {
    return res.status(400).json({ error: 'pdf_base64 is required' });
  }

  // Rough size check (base64 is ~4/3 of binary)
  const estimatedSizeMB = (pdf_base64.length * 3) / 4 / 1024 / 1024;
  if (estimatedSizeMB > MAX_PDF_SIZE_MB) {
    return res.status(413).json({ error: `PDF too large (max ${MAX_PDF_SIZE_MB}MB)` });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16384,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: pdf_base64,
                },
              },
              {
                type: 'text',
                text: `Extract every transaction from this bank statement into CSV format.

Rules:
- Output ONLY valid CSV, no explanation or markdown fences
- First row must be the header: Date,Description,Amount
- Date column: YYYY-MM-DD format
- Description column: merchant or transaction description, no commas (replace with spaces)
- Amount column: negative for debits/spending, positive for credits/income (e.g. -45.99 or 1200.00)
- Include ALL transactions — do not skip any
- If a date is ambiguous (e.g. "15 Jan"), use the year from the statement
- Ignore opening/closing balances, interest summaries, and non-transaction rows
- If you cannot parse the statement, respond with exactly: ERROR: Could not parse bank statement`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Claude API error:', err);
      return res.status(502).json({ error: 'Failed to process PDF' });
    }

    const data = await response.json();
    let csv = data.content?.[0]?.text || '';

    // Strip any code fences Claude might add
    csv = csv.replace(/^```(?:\w+)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    if (csv.startsWith('ERROR:')) {
      return res.status(422).json({ error: csv });
    }

    // Basic validation: must have header + at least 1 transaction
    const lines = csv.split('\n').filter((l) => l.trim());
    if (lines.length < 2 || !lines[0].toLowerCase().includes('date')) {
      return res.status(422).json({ error: 'Could not extract transactions from this PDF' });
    }

    return res.json({ success: true, csv_data: csv });
  } catch (err) {
    console.error('Parse statement error:', err);
    return res.status(500).json({ error: err.message });
  }
}
