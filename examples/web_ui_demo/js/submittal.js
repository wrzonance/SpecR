function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionButton(source, ctx) {
  const label = ctx.displaySection ? ctx.displaySection(source.section) : source.section;
  const btn = el('button', 'coord-section', label);
  btn.type = 'button';
  btn.title = `Jump to Section ${source.section}`;
  btn.addEventListener('click', () => ctx.onNavigate?.(source.section));
  return btn;
}

function textList(items, emptyText) {
  const wrap = el('div', 'submittal-lines');
  if (items.length === 0) {
    wrap.appendChild(el('span', 'coord-empty', emptyText));
    return wrap;
  }
  for (const item of items) wrap.appendChild(el('span', null, item));
  return wrap;
}

function sourceList(sources, ctx) {
  const wrap = el('div', 'submittal-lines');
  for (const source of sources) {
    const line = el('span', 'submittal-source');
    line.appendChild(sectionButton(source, ctx));
    line.appendChild(el('span', 'submittal-paragraph', source.paragraphId.slice(0, 8)));
    wrap.appendChild(line);
  }
  return wrap;
}

function statusCell(row) {
  const status = el(
    'span',
    `submittal-status is-${row.datasheetStatus}`,
    row.datasheetStatus === 'present' ? 'PRESENT' : 'MISSING'
  );
  status.title =
    row.datasheetStatus === 'present'
      ? 'At least one datasheet association is attached'
      : 'No datasheet association is attached';
  return status;
}

function renderRow(row, ctx) {
  const tr = el('tr');
  const product = el('td', 'submittal-product', row.productName);
  const source = el('td');
  const types = el('td');
  const sheets = el('td');
  const status = el('td');
  source.appendChild(sourceList(row.sources, ctx));
  types.appendChild(textList(row.requiredSubmittalTypes, 'No required type'));
  sheets.appendChild(
    textList(
      row.datasheets.map((sheet) => sheet.label),
      'No datasheet'
    )
  );
  status.appendChild(statusCell(row));
  tr.append(product, source, types, sheets, status);
  return tr;
}

function headerCell(text) {
  return el('th', null, text);
}

function tableHead() {
  const thead = el('thead');
  const row = el('tr');
  row.append(
    headerCell('Product'),
    headerCell('Source'),
    headerCell('Required Types'),
    headerCell('Datasheets'),
    headerCell('Status')
  );
  thead.appendChild(row);
  return thead;
}

function renderTable(report, ctx) {
  const table = el('table', 'submittal-table');
  const tbody = el('tbody');
  table.appendChild(tableHead());
  for (const row of report.rows) tbody.appendChild(renderRow(row, ctx));
  table.appendChild(tbody);
  return table;
}

export function renderSubmittalRegister(container, report, ctx = {}) {
  container.replaceChildren();
  if (!report) {
    container.appendChild(el('p', 'coord-empty', 'Submittal register unavailable in this build.'));
    return;
  }

  const summary = el('div', 'coord-summary');
  summary.appendChild(el('span', 'coord-total', `${report.summary.rows} ROWS`));
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.productMissingDatasheet} MISSING DATASHEETS`)
  );
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.totalFindings} SUBMITTAL FINDINGS`)
  );
  container.appendChild(summary);

  if (report.rows.length === 0) {
    container.appendChild(el('p', 'coord-empty', 'No Part 2 products in selected project specs.'));
    return;
  }
  container.appendChild(renderTable(report, ctx));
}
