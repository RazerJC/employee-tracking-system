(() => {
    const list = document.getElementById('manpower-position-list');
    const dialog = document.getElementById('manpower-position-dialog');
    const form = document.getElementById('manpower-catalog-form');
    const heading = document.getElementById('position-dialog-title');
    const note = document.getElementById('position-dialog-note');
    const fields = document.getElementById('position-dialog-fields');
    const error = document.getElementById('position-dialog-error');
    const save = document.getElementById('save-catalog-position');
    const cancel = document.getElementById('cancel-catalog-position');
    const status = document.getElementById('position-catalog-status');
    const add = document.getElementById('add-catalog-position');
    const rowTemplate = document.getElementById('manpower-position-template');
    const titleInput = form.elements.title;
    const descriptionInput = form.elements.description;
    let action;
    let row;

    function openEditor(nextAction, selectedRow = null) {
        action = nextAction;
        row = selectedRow;
        const title = row?.querySelector('[data-position-title]').textContent ?? '';
        const archiving = action === 'archive';
        heading.textContent = { create: 'Add Position', edit: 'Edit Position', archive: 'Delete Position' }[action];
        note.textContent = archiving
            ? `Remove ${title} from new requests? Existing records keep it.`
            : 'Changes apply to the shared position list.';
        fields.hidden = archiving;
        titleInput.required = !archiving;
        titleInput.value = title;
        descriptionInput.value = row?.querySelector('[data-position-description]').textContent ?? '';
        save.textContent = archiving ? 'Delete' : 'Save Position';
        error.hidden = true;
        dialog.showModal();
        (archiving ? cancel : titleInput).focus();
    }

    add.addEventListener('click', () => openEditor('create'));
    list.addEventListener('click', event => {
        const button = event.target.closest('[data-position-action]');
        if (button) openEditor(button.dataset.positionAction, button.closest('[data-position-id]'));
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => {
        if (save.disabled) event.preventDefault();
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        save.disabled = true;
        cancel.disabled = true;
        error.hidden = true;
        const data = new URLSearchParams(new FormData(form));
        data.set('action', action);
        if (row) data.set('position_id', row.dataset.positionId);

        try {
            const response = await fetch(form.action, { method: 'POST', body: data });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.position) {
                throw new Error(result.error || 'Could not save the position. Refresh and try again.');
            }
            const position = result.position;
            if (action === 'archive') {
                if (row.dataset.requested === 'true') {
                    row.querySelector('[data-position-archived]').hidden = false;
                    for (const button of row.querySelectorAll('[data-position-action]')) button.remove();
                } else {
                    row.remove();
                }
            } else {
                if (!row) {
                    row = rowTemplate.content.firstElementChild.cloneNode(true);
                    row.dataset.positionId = position.id;
                    list.append(row);
                }
                row.querySelector('[data-position-title]').textContent = position.title;
                row.querySelector('[data-position-description]').textContent = position.description ?? '';
                row.querySelector('[data-position-action="edit"]').setAttribute('aria-label', `Edit ${position.title}`);
                row.querySelector('[data-position-action="archive"]').setAttribute('aria-label', `Delete ${position.title}`);
                const quantity = row.querySelector('input[type="number"]');
                quantity.name = `positions[p_${position.id}]`;
                quantity.setAttribute('aria-label', `${position.title} quantity`);
            }
            status.textContent = action === 'archive' ? `${position.title} removed from new requests.` : `${position.title} saved.`;
            dialog.close();
            (row.isConnected ? row.querySelector('input[type="number"]') : add).focus();
        } catch (failure) {
            error.textContent = failure.message;
            error.hidden = false;
        } finally {
            save.disabled = false;
            cancel.disabled = false;
        }
    });
})();
