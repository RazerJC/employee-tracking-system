(() => {
    const form = document.getElementById('worker-batch');
    if (!form) return;

    const list = document.getElementById('worker-batch-rows');
    const add = document.getElementById('add-worker');
    const send = document.getElementById('send-workers');
    const count = document.getElementById('worker-batch-count');
    const template = list.firstElementChild.cloneNode(true);
    const available = new Map([...template.querySelectorAll('[data-remaining]')].map(option => [option.value, Number(option.dataset.remaining)]));
    const total = [...available.values()].reduce((sum, slots) => sum + slots, 0);

    function refreshRows() {
        const rows = [...list.children];
        const used = new Map();
        for (const row of rows) {
            const position = row.querySelector('[data-field="request_position_id"]');
            used.set(position.value, (used.get(position.value) || 0) + 1);
        }

        rows.forEach((row, index) => {
            row.querySelector('legend').textContent = 'Worker ' + (index + 1);
            const source = row.querySelector('[data-field="worker_type"]').value;
            for (const field of row.querySelectorAll('[data-field]')) {
                field.name = 'workers[' + index + '][' + field.dataset.field + ']';
                const sourceGroup = field.closest('[data-worker-source]');
                if (!sourceGroup) continue;
                const enabled = sourceGroup.dataset.workerSource === source;
                sourceGroup.hidden = !enabled;
                field.disabled = !enabled;
                field.required = enabled;
            }
            const position = row.querySelector('[data-field="request_position_id"]');
            position.setCustomValidity(used.get(position.value) > available.get(position.value) ? 'This position has no more open slots.' : '');
            const remove = row.querySelector('[data-remove-worker]');
            remove.disabled = rows.length === 1;
            remove.setAttribute('aria-label', 'Remove Worker ' + (index + 1));
        });
        count.textContent = rows.length + ' of ' + total + ' open slots in this batch';
        add.disabled = rows.length >= total;
        return used;
    }

    add.addEventListener('click', () => {
        const used = refreshRows();
        const next = [...available].find(([id, slots]) => (used.get(id) || 0) < slots);
        if (!next || add.disabled) return;
        const row = template.cloneNode(true);
        row.querySelector('[data-field="request_position_id"]').value = next[0];
        list.append(row);
        refreshRows();
        row.querySelector('[data-field="worker_name"]').focus();
    });

    list.addEventListener('change', refreshRows);
    list.addEventListener('click', event => {
        const remove = event.target.closest('[data-remove-worker]');
        if (!remove || remove.disabled) return;
        remove.closest('[data-worker-row]').remove();
        refreshRows();
        add.focus();
    });
    form.addEventListener('submit', () => { send.disabled = true; });
    refreshRows();
})();
