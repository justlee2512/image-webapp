(() => {
  'use strict';

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const currentFolderId = document.body.dataset.folderId || '';
  const toastStack = document.querySelector('#toast-stack');

  function showToast(message, type = 'error') {
    if (!message) return;
    if (!toastStack) {
      window.alert(message);
      return;
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type} is-visible`;
    toast.textContent = message;
    toastStack.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add('is-hiding');
      window.setTimeout(() => toast.remove(), 240);
    }, 3200);
  }

  document.querySelectorAll('.alert').forEach((alert) => {
    if (alert.hasAttribute('data-live-alert')) return;
    window.setTimeout(() => {
      alert.classList.add('is-hiding');
      window.setTimeout(() => alert.remove(), 240);
    }, 4200);
  });

  document.querySelectorAll('form[data-confirm]:not([data-ajax-form])').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!window.confirm(form.dataset.confirm || 'Bạn có chắc muốn thực hiện thao tác này?')) {
        event.preventDefault();
      }
    });
  });

  document.querySelectorAll('[data-confirm-button]').forEach((button) => {
    button.addEventListener('click', (event) => {
      if (!window.confirm(button.dataset.confirmButton || 'Bạn có chắc muốn thực hiện thao tác này?')) {
        event.preventDefault();
      }
    });
  });

  async function parseJson(response) {
    return response.json().catch(() => ({ ok: false, message: 'Phản hồi từ máy chủ không hợp lệ.' }));
  }

  async function postUrlEncoded(url, values = {}) {
    const body = new URLSearchParams();
    body.set('_csrf', csrfToken);
    Object.entries(values).forEach(([key, value]) => {
      const items = Array.isArray(value) ? value : [value];
      items.forEach((item) => body.append(key, item ?? ''));
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrfToken,
        Accept: 'application/json'
      },
      credentials: 'same-origin',
      body
    });
    const payload = await parseJson(response);
    if (!response.ok || !payload.ok) throw new Error(payload.message || 'Không thể hoàn thành thao tác.');
    return payload;
  }

  document.querySelectorAll('form[data-ajax-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return;
      const submitter = event.submitter;
      const submitButton = submitter || form.querySelector('button[type="submit"]');
      const originalText = submitButton?.textContent;
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Đang xử lý…';
      }
      try {
        const action = submitter?.getAttribute('formaction') || form.action;
        const formData = new FormData(form);
        if (!formData.has('_csrf')) formData.set('_csrf', csrfToken);
        const response = await fetch(action, {
          method: (form.method || 'POST').toUpperCase(),
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-Token': csrfToken,
            Accept: 'application/json'
          },
          credentials: 'same-origin',
          body: formData
        });
        const payload = await parseJson(response);
        if (!response.ok || !payload.ok) throw new Error(payload.message || 'Không thể hoàn thành thao tác.');
        showToast(payload.message || 'Thao tác thành công.', 'success');
        window.setTimeout(() => window.location.assign(form.dataset.successRedirect || window.location.href), 250);
      } catch (error) {
        showToast(error.message || 'Không thể hoàn thành thao tác.', 'error');
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalText;
        }
      }
    });
  });

  // Sequential upload preserves the old UI while limiting memory and database pressure.
  const imageInput = document.querySelector('#image-input');
  const uploadForm = document.querySelector('.upload-form');
  const progressBox = document.querySelector('#upload-progress');
  const progressBar = document.querySelector('#upload-bar');
  const progressStatus = document.querySelector('#upload-status');
  const progressPercent = document.querySelector('#upload-percent');

  function uploadOne(file, folderId, index, total) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      const data = new FormData();
      data.set('_csrf', csrfToken);
      data.set('folderId', folderId);
      data.set('image', file, file.name);
      request.open('POST', '/images');
      request.responseType = 'json';
      request.timeout = 180000;
      request.setRequestHeader('X-CSRF-Token', csrfToken);
      request.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      request.setRequestHeader('X-Upload-Queue', 'sequential');
      request.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable || !progressBar || !progressPercent) return;
        const totalProgress = Math.round(((index + (event.loaded / event.total)) / total) * 100);
        progressBar.value = totalProgress;
        progressPercent.textContent = `${totalProgress}%`;
      });
      request.addEventListener('load', () => {
        const payload = request.response || {};
        if (request.status >= 200 && request.status < 300 && payload.ok) resolve(payload);
        else reject(new Error(payload.message || `Không thể tải ${file.name}.`));
      });
      request.addEventListener('timeout', () => reject(new Error(`Tải ${file.name} quá thời gian cho phép.`)));
      request.addEventListener('error', () => reject(new Error(`Mất kết nối khi tải ${file.name}.`)));
      request.send(data);
    });
  }

  if (imageInput && uploadForm) {
    imageInput.addEventListener('change', async () => {
      const files = [...imageInput.files];
      if (!files.length) return;
      const maxSizeMb = Number(imageInput.dataset.maxSizeMb || document.body.dataset.maxFileSizeMb || 30);
      const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
      const invalid = files.find((file) => !allowedTypes.has(file.type));
      const oversized = files.find((file) => file.size > maxSizeMb * 1024 * 1024);
      if (invalid) {
        showToast(`${invalid.name} không phải định dạng ảnh được hỗ trợ.`, 'error');
        imageInput.value = '';
        return;
      }
      if (oversized) {
        showToast(`${oversized.name} lớn hơn giới hạn ${maxSizeMb} MB.`, 'error');
        imageInput.value = '';
        return;
      }

      const folderId = uploadForm.querySelector('[name="folderId"]')?.value || '';
      const uploadButton = uploadForm.querySelector('.upload-button');
      imageInput.disabled = true;
      uploadButton?.classList.add('disabled');
      if (progressBox) {
        progressBox.hidden = false;
        progressBox.classList.remove('upload-failed');
      }
      let completed = 0;
      try {
        for (let index = 0; index < files.length; index += 1) {
          if (progressStatus) progressStatus.textContent = `Đang tải ${index + 1}/${files.length}: ${files[index].name}`;
          await uploadOne(files[index], folderId, index, files.length);
          completed += 1;
          const percent = Math.round((completed / files.length) * 100);
          if (progressBar) progressBar.value = percent;
          if (progressPercent) progressPercent.textContent = `${percent}%`;
        }
        if (progressStatus) progressStatus.textContent = `Hoàn tất ${completed}/${files.length} ảnh. Đang làm mới…`;
        window.location.reload();
      } catch (error) {
        if (progressStatus) progressStatus.textContent = `${error.message} Đã hoàn thành ${completed}/${files.length} ảnh.`;
        progressBox?.classList.add('upload-failed');
        imageInput.disabled = false;
        uploadButton?.classList.remove('disabled');
        imageInput.value = '';
        showToast(error.message || 'Không thể tải ảnh.', 'error');
      }
    });
  }

  // Batch selection.
  const selectAll = document.querySelector('#select-all');
  const checkboxes = [...document.querySelectorAll('.image-checkbox')];
  const batchDownload = document.querySelector('#batch-download');
  const batchDelete = document.querySelector('#batch-delete');
  const batchMove = document.querySelector('#batch-move');
  const deleteAll = document.querySelector('.delete-all');

  function selectedIds() {
    return checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
  }

  function updateBatchButtons() {
    const selected = selectedIds().length;
    checkboxes.forEach((checkbox) => checkbox.closest('.photo-card')?.classList.toggle('is-selected', checkbox.checked));
    if (batchDownload) {
      batchDownload.disabled = selected === 0;
      batchDownload.textContent = selected ? `↓ Tải ${selected} ảnh (.zip)` : '↓ Tải ảnh đã chọn';
    }
    if (batchDelete) {
      batchDelete.disabled = selected === 0;
      batchDelete.textContent = selected ? `⌫ Xóa ${selected} ảnh` : '⌫ Xóa ảnh đã chọn';
    }
    if (batchMove) batchMove.disabled = selected === 0;
    if (selectAll) {
      selectAll.checked = checkboxes.length > 0 && selected === checkboxes.length;
      selectAll.indeterminate = selected > 0 && selected < checkboxes.length;
    }
  }

  selectAll?.addEventListener('change', () => {
    checkboxes.forEach((checkbox) => { checkbox.checked = selectAll.checked; });
    updateBatchButtons();
  });
  checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateBatchButtons));
  updateBatchButtons();

  batchDelete?.addEventListener('click', (event) => {
    const count = selectedIds().length;
    if (!window.confirm(`Bạn chắc chắn muốn xóa ${count} ảnh đã chọn? Hành động này không thể hoàn tác.`)) event.preventDefault();
  });
  deleteAll?.addEventListener('click', (event) => {
    if (!window.confirm(`Xóa toàn bộ ${checkboxes.length} ảnh trong thư mục hiện tại? Hành động này không thể hoàn tác.`)) event.preventDefault();
  });

  // Drag one or multiple selected images into a folder card.
  const draggableCards = [...document.querySelectorAll('.photo-card[draggable="true"]')];
  const folderTargets = [...document.querySelectorAll('.folder-drop-target[data-folder-id]')];
  draggableCards.forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      const selected = selectedIds();
      const ids = selected.includes(card.dataset.imageId) ? selected : [card.dataset.imageId];
      event.dataTransfer?.setData('application/json', JSON.stringify(ids));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  folderTargets.forEach((folder) => {
    folder.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      folder.classList.add('drag-over');
    });
    folder.addEventListener('dragleave', () => folder.classList.remove('drag-over'));
    folder.addEventListener('drop', async (event) => {
      event.preventDefault();
      folder.classList.remove('drag-over');
      try {
        const ids = JSON.parse(event.dataTransfer?.getData('application/json') || '[]');
        if (!Array.isArray(ids) || !ids.length) return;
        const payload = await postUrlEncoded('/images/move', {
          imageIds: ids,
          targetFolderId: folder.dataset.folderId,
          currentFolderId
        });
        showToast(payload.message || 'Đã di chuyển ảnh.', 'success');
        window.setTimeout(() => window.location.reload(), 250);
      } catch (error) {
        showToast(error.message || 'Không thể di chuyển ảnh.', 'error');
      }
    });
  });

  // Lightbox with keyboard navigation, wheel zoom and drag-to-pan.
  const lightbox = document.querySelector('#lightbox');
  const previews = [...document.querySelectorAll('.photo-preview[data-image-id]')];
  const lightboxImage = document.querySelector('#lightbox-image');
  const lightboxName = document.querySelector('#lightbox-name');
  const lightboxCount = document.querySelector('#lightbox-count');
  const lightboxDownload = document.querySelector('#lightbox-download');
  const lightboxLoader = document.querySelector('#lightbox-loader');
  const lightboxStage = document.querySelector('.lightbox-stage');
  const previousButton = document.querySelector('#lightbox-prev');
  const nextButton = document.querySelector('#lightbox-next');
  const zoomInButton = document.querySelector('#zoom-in');
  const zoomOutButton = document.querySelector('#zoom-out');
  const zoomLevelButton = document.querySelector('#zoom-level');
  let currentIndex = 0;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let panning = false;
  let startX = 0;
  let startY = 0;

  function applyZoom() {
    if (!lightboxImage || !lightboxStage) return;
    lightboxImage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    lightboxStage.classList.toggle('is-zoomed', zoom > 1);
    if (zoomLevelButton) zoomLevelButton.textContent = `${Math.round(zoom * 100)}%`;
  }

  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyZoom();
  }

  function setZoom(nextZoom) {
    zoom = Math.min(4, Math.max(0.5, Math.round(nextZoom * 100) / 100));
    if (zoom <= 1) {
      panX = 0;
      panY = 0;
    }
    applyZoom();
  }

  function showImage(index) {
    if (!previews.length || !lightboxImage) return;
    currentIndex = (index + previews.length) % previews.length;
    const preview = previews[currentIndex];
    const imageId = preview.dataset.imageId;
    const imageName = preview.dataset.imageName || 'Ảnh';
    resetZoom();
    lightboxImage.classList.remove('loaded');
    lightboxImage.alt = imageName;
    if (lightboxLoader) lightboxLoader.hidden = false;
    if (lightboxName) lightboxName.textContent = imageName;
    if (lightboxCount) lightboxCount.textContent = `${currentIndex + 1} / ${previews.length}`;
    if (lightboxDownload) lightboxDownload.href = `/images/${encodeURIComponent(imageId)}/download`;
    lightboxImage.onload = () => {
      lightboxImage.classList.add('loaded');
      if (lightboxLoader) lightboxLoader.hidden = true;
    };
    lightboxImage.onerror = () => {
      if (lightboxLoader) lightboxLoader.hidden = true;
      showToast('Không thể tải ảnh để xem.', 'error');
    };
    lightboxImage.src = `/images/${encodeURIComponent(imageId)}`;
  }

  function openLightbox(index) {
    if (!lightbox) return;
    showImage(index);
    lightbox.classList.add('open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-open');
    document.querySelector('[data-lightbox-close]')?.focus({ preventScroll: true });
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-open');
    if (lightboxImage) {
      lightboxImage.removeAttribute('src');
      lightboxImage.classList.remove('loaded');
    }
    resetZoom();
  }

  previews.forEach((preview, index) => preview.addEventListener('click', () => openLightbox(index)));
  document.querySelectorAll('[data-lightbox-close]').forEach((button) => button.addEventListener('click', closeLightbox));
  previousButton?.addEventListener('click', () => showImage(currentIndex - 1));
  nextButton?.addEventListener('click', () => showImage(currentIndex + 1));
  zoomInButton?.addEventListener('click', () => setZoom(zoom + 0.25));
  zoomOutButton?.addEventListener('click', () => setZoom(zoom - 0.25));
  zoomLevelButton?.addEventListener('click', resetZoom);
  lightboxImage?.addEventListener('dblclick', () => setZoom(zoom > 1 ? 1 : 2));
  lightboxStage?.addEventListener('wheel', (event) => {
    if (lightbox?.getAttribute('aria-hidden') === 'true') return;
    event.preventDefault();
    setZoom(zoom + (event.deltaY < 0 ? 0.2 : -0.2));
  }, { passive: false });
  lightboxStage?.addEventListener('pointerdown', (event) => {
    if (zoom <= 1) return;
    panning = true;
    startX = event.clientX - panX;
    startY = event.clientY - panY;
    lightboxStage.setPointerCapture(event.pointerId);
    lightboxStage.classList.add('is-panning');
  });
  lightboxStage?.addEventListener('pointermove', (event) => {
    if (!panning) return;
    panX = event.clientX - startX;
    panY = event.clientY - startY;
    applyZoom();
  });
  const stopPanning = (event) => {
    if (!panning) return;
    panning = false;
    lightboxStage?.classList.remove('is-panning');
    if (event?.pointerId != null && lightboxStage?.hasPointerCapture(event.pointerId)) lightboxStage.releasePointerCapture(event.pointerId);
  };
  lightboxStage?.addEventListener('pointerup', stopPanning);
  lightboxStage?.addEventListener('pointercancel', stopPanning);

  document.addEventListener('keydown', (event) => {
    if (!lightbox || lightbox.getAttribute('aria-hidden') === 'true') return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') showImage(currentIndex - 1);
    if (event.key === 'ArrowRight') showImage(currentIndex + 1);
    if (event.key === '+' || event.key === '=') setZoom(zoom + 0.25);
    if (event.key === '-') setZoom(zoom - 0.25);
    if (event.key === '0') resetZoom();
  });
})();
