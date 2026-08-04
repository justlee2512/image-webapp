(() => {
  'use strict';

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const folderId = document.body.dataset.folderId || '';
  const maxFileSize = Number(document.body.dataset.maxFileSizeMb || 30) * 1024 * 1024;
  const alertBox = document.querySelector('[data-live-alert]');

  function showAlert(message, type = 'success') {
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.className = `alert alert-${type}`;
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function postForm(url, values) {
    const body = new URLSearchParams();
    body.set('_csrf', csrfToken);
    Object.entries(values).forEach(([key, value]) => {
      const list = Array.isArray(value) ? value : [value];
      list.forEach((item) => body.append(key, item ?? ''));
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken,
        Accept: 'application/json'
      },
      body,
      credentials: 'same-origin'
    });
    const payload = await response.json().catch(() => ({ ok: false, message: 'Phản hồi từ server không hợp lệ.' }));
    if (!response.ok || !payload.ok) throw new Error(payload.message || 'Không thể hoàn thành thao tác.');
    return payload;
  }

  document.querySelectorAll('[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  });

  document.querySelectorAll('[data-ajax-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrfToken, Accept: 'application/json' },
          body: new FormData(form),
          credentials: 'same-origin'
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.message);
        window.location.reload();
      } catch (error) {
        showAlert(error.message || 'Không thể hoàn thành thao tác.', 'error');
        if (submit) submit.disabled = false;
      }
    });
  });

  const searchInput = document.querySelector('[data-search]');
  if (searchInput) {
    const items = [...document.querySelectorAll('[data-search-item]')];
    let timer;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const term = searchInput.value.trim().toLocaleLowerCase('vi');
        items.forEach((item) => {
          item.hidden = Boolean(term) && !item.dataset.searchItem.toLocaleLowerCase('vi').includes(term);
        });
      }, 80);
    });
  }

  const checkboxes = [...document.querySelectorAll('[data-image-select]')];
  const toolbar = document.querySelector('[data-selection-toolbar]');
  const selectedCount = document.querySelector('[data-selected-count]');
  const selectAllButton = document.querySelector('[data-select-all]');

  function selectedIds() {
    return checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
  }

  function updateSelection() {
    const selected = selectedIds();
    if (toolbar) toolbar.hidden = selected.length === 0;
    if (selectedCount) selectedCount.textContent = String(selected.length);
    checkboxes.forEach((checkbox) => checkbox.closest('.image-card')?.classList.toggle('is-selected', checkbox.checked));
    if (selectAllButton) selectAllButton.textContent = selected.length === checkboxes.length && checkboxes.length ? 'Bỏ chọn' : 'Chọn tất cả';
  }

  checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateSelection));
  selectAllButton?.addEventListener('click', () => {
    const visible = checkboxes.filter((checkbox) => !checkbox.closest('.image-card')?.hidden);
    const shouldSelect = visible.some((checkbox) => !checkbox.checked);
    visible.forEach((checkbox) => { checkbox.checked = shouldSelect; });
    updateSelection();
  });

  document.querySelector('[data-move-selected]')?.addEventListener('click', async () => {
    const ids = selectedIds();
    const targetFolderId = document.querySelector('[data-move-target]')?.value || '';
    if (!ids.length) return;
    try {
      const payload = await postForm('/images/move', { imageIds: ids, targetFolderId, currentFolderId: folderId });
      showAlert(payload.message);
      ids.forEach((id) => document.querySelector(`[data-image-id="${CSS.escape(id)}"]`)?.remove());
      checkboxes.splice(0, checkboxes.length, ...document.querySelectorAll('[data-image-select]'));
      updateSelection();
    } catch (error) {
      showAlert(error.message, 'error');
    }
  });

  document.querySelector('[data-delete-selected]')?.addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length || !window.confirm(`Xóa vĩnh viễn ${ids.length} ảnh đã chọn?`)) return;
    try {
      const payload = await postForm('/images/delete-batch', { imageIds: ids, folderId });
      showAlert(payload.message);
      ids.forEach((id) => document.querySelector(`[data-image-id="${CSS.escape(id)}"]`)?.remove());
      checkboxes.splice(0, checkboxes.length, ...document.querySelectorAll('[data-image-select]'));
      updateSelection();
    } catch (error) {
      showAlert(error.message, 'error');
    }
  });

  document.querySelector('[data-download-selected]')?.addEventListener('click', () => {
    const ids = selectedIds();
    if (!ids.length) return;
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/images/download-batch';
    form.hidden = true;
    const entries = [['_csrf', csrfToken], ...ids.map((id) => ['imageIds', id])];
    entries.forEach(([name, value]) => {
      const input = document.createElement('input');
      input.name = name;
      input.value = value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => form.remove(), 1000);
  });

  const uploadDialog = document.querySelector('[data-upload-dialog]');
  const fileInput = document.querySelector('[data-file-input]');
  const dropZone = document.querySelector('[data-drop-zone]');
  const startUpload = document.querySelector('[data-start-upload]');
  const cancelUpload = document.querySelector('[data-cancel-upload]');
  const summary = document.querySelector('[data-upload-summary]');
  const fileName = document.querySelector('[data-upload-file-name]');
  const progress = document.querySelector('[data-upload-progress]');
  const progressText = document.querySelector('[data-upload-progress-text]');
  const uploadStatus = document.querySelector('[data-upload-status]');
  let pendingFiles = [];
  let activeXhr = null;
  let cancelled = false;

  function openUpload(files = []) {
    if (!uploadDialog) return;
    if (!uploadDialog.open) uploadDialog.showModal();
    if (files.length) setPendingFiles(files);
  }

  function setPendingFiles(files) {
    pendingFiles = [...files].filter((file) => file.type.startsWith('image/'));
    const oversized = pendingFiles.find((file) => file.size > maxFileSize);
    if (oversized) {
      showAlert(`${oversized.name} vượt giới hạn dung lượng.`, 'error');
      pendingFiles = pendingFiles.filter((file) => file.size <= maxFileSize);
    }
    if (startUpload) startUpload.disabled = pendingFiles.length === 0;
    if (summary) summary.hidden = pendingFiles.length === 0;
    if (fileName) fileName.textContent = pendingFiles.length ? `${pendingFiles.length} ảnh đã chọn` : 'Chưa chọn ảnh';
    if (uploadStatus) uploadStatus.textContent = pendingFiles.length ? `Tổng dung lượng ${(pendingFiles.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(2)} MB` : '';
    if (progress) progress.value = 0;
    if (progressText) progressText.textContent = '0%';
  }

  document.querySelectorAll('[data-open-upload]').forEach((button) => button.addEventListener('click', () => openUpload()));
  dropZone?.addEventListener('click', () => fileInput?.click());
  dropZone?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput?.click(); }
  });
  fileInput?.addEventListener('change', () => setPendingFiles(fileInput.files));
  ['dragenter', 'dragover'].forEach((type) => dropZone?.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  }));
  ['dragleave', 'drop'].forEach((type) => dropZone?.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  }));
  dropZone?.addEventListener('drop', (event) => setPendingFiles(event.dataTransfer.files));

  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    if (!uploadDialog || dropZone?.contains(event.target)) return;
    event.preventDefault();
    openUpload(event.dataTransfer.files);
  });

  function uploadOne(file, index, total) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhr = xhr;
      xhr.open('POST', '/images');
      xhr.responseType = 'json';
      xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.setRequestHeader('X-Upload-Queue', 'sequential');
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        const current = event.loaded / event.total;
        const overall = Math.round(((index + current) / total) * 100);
        if (progress) progress.value = overall;
        if (progressText) progressText.textContent = `${overall}%`;
      });
      xhr.addEventListener('load', () => {
        activeXhr = null;
        const payload = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300 && payload.ok) resolve(payload);
        else reject(new Error(payload.message || `Không thể tải ${file.name}.`));
      });
      xhr.addEventListener('error', () => reject(new Error(`Mất kết nối khi tải ${file.name}.`)));
      xhr.addEventListener('abort', () => reject(new DOMException('Đã hủy tải lên.', 'AbortError')));
      const formData = new FormData();
      formData.append('image', file, file.name);
      if (folderId) formData.append('folderId', folderId);
      xhr.send(formData);
    });
  }

  startUpload?.addEventListener('click', async () => {
    if (!pendingFiles.length) return;
    cancelled = false;
    startUpload.disabled = true;
    if (cancelUpload) cancelUpload.textContent = 'Hủy tải';
    let completed = 0;
    try {
      for (let index = 0; index < pendingFiles.length; index += 1) {
        if (cancelled) break;
        const file = pendingFiles[index];
        if (fileName) fileName.textContent = file.name;
        if (uploadStatus) uploadStatus.textContent = `Đang tải ảnh ${index + 1}/${pendingFiles.length}`;
        await uploadOne(file, index, pendingFiles.length);
        completed += 1;
      }
      if (!cancelled) {
        if (progress) progress.value = 100;
        if (progressText) progressText.textContent = '100%';
        if (uploadStatus) uploadStatus.textContent = `Đã tải thành công ${completed} ảnh. Đang làm mới thư viện…`;
        setTimeout(() => window.location.reload(), 500);
      }
    } catch (error) {
      if (error.name !== 'AbortError') showAlert(error.message, 'error');
      if (uploadStatus) uploadStatus.textContent = error.message;
      startUpload.disabled = false;
    }
  });

  cancelUpload?.addEventListener('click', () => {
    if (activeXhr) {
      cancelled = true;
      activeXhr.abort();
      activeXhr = null;
    } else {
      uploadDialog?.close();
      setPendingFiles([]);
    }
  });
  uploadDialog?.addEventListener('close', () => { if (!activeXhr) setPendingFiles([]); });

  const lightbox = document.querySelector('[data-lightbox]');
  const lightboxImage = document.querySelector('[data-lightbox-image]');
  const lightboxTitle = document.querySelector('[data-lightbox-title]');
  const lightboxDownload = document.querySelector('[data-lightbox-download]');
  document.querySelectorAll('[data-lightbox-src]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!lightbox || !lightboxImage) return;
      lightboxImage.src = button.dataset.lightboxSrc;
      lightboxImage.alt = button.dataset.lightboxName || '';
      if (lightboxTitle) lightboxTitle.textContent = button.dataset.lightboxName || '';
      if (lightboxDownload) lightboxDownload.href = `${button.dataset.lightboxSrc}/download`;
      lightbox.showModal();
    });
  });
  lightbox?.addEventListener('close', () => { if (lightboxImage) lightboxImage.src = ''; });
  [uploadDialog, lightbox].forEach((dialog) => dialog?.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    if (outside) dialog.close();
  }));

  updateSelection();
})();
