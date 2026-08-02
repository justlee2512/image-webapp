const input = document.querySelector('#image-input');
const uploadForm = document.querySelector('.upload-form');
const progressBox = document.querySelector('#upload-progress');
const progressBar = document.querySelector('#upload-bar');
const progressStatus = document.querySelector('#upload-status');
const progressPercent = document.querySelector('#upload-percent');

function uploadOne(file, folderId, index, total) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const data = new FormData();
    data.append('folderId', folderId);
    data.append('image', file, file.name);
    request.open('POST', '/images');
    request.setRequestHeader('X-Upload-Queue', 'sequential');
    request.responseType = 'json';
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const fileProgress = event.loaded / event.total;
      const totalProgress = Math.round(((index + fileProgress) / total) * 100);
      progressBar.value = totalProgress;
      progressPercent.textContent = `${totalProgress}%`;
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300 && request.response?.ok) resolve();
      else reject(new Error(request.response?.message || `Không thể tải ${file.name}.`));
    });
    request.addEventListener('error', () => reject(new Error(`Mất kết nối khi tải ${file.name}.`)));
    request.send(data);
  });
}

if (input && uploadForm) input.addEventListener('change', async () => {
  const files = [...input.files];
  if (!files.length) return;
  const maxSizeMb = Number(input.dataset.maxSizeMb || 30);
  const oversized = files.find((file) => file.size > maxSizeMb * 1024 * 1024);
  if (oversized) {
    window.alert(`${oversized.name} lớn hơn giới hạn ${maxSizeMb} MB.`);
    input.value = '';
    return;
  }
  const folderId = uploadForm.querySelector('[name="folderId"]').value;
  const uploadButton = uploadForm.querySelector('.upload-button');
  input.disabled = true;
  uploadButton.classList.add('disabled');
  progressBox.hidden = false;
  let completed = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      progressStatus.textContent = `Đang tải ${index + 1}/${files.length}: ${files[index].name}`;
      await uploadOne(files[index], folderId, index, files.length);
      completed += 1;
      const percent = Math.round((completed / files.length) * 100);
      progressBar.value = percent;
      progressPercent.textContent = `${percent}%`;
    }
    progressStatus.textContent = `Hoàn tất ${completed}/${files.length} ảnh. Đang làm mới…`;
    window.location.reload();
  } catch (error) {
    progressStatus.textContent = `${error.message} Đã hoàn thành ${completed}/${files.length} ảnh.`;
    progressBox.classList.add('upload-failed');
    input.disabled = false;
    uploadButton.classList.remove('disabled');
    input.value = '';
  }
});

const selectAll = document.querySelector('#select-all');
const checkboxes = [...document.querySelectorAll('.image-checkbox')];
const batchDownload = document.querySelector('#batch-download');
const batchDelete = document.querySelector('#batch-delete');
const batchMove = document.querySelector('#batch-move');
function updateBatchButton() {
  const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
  if (batchDownload) {
    batchDownload.disabled = selected === 0;
    batchDownload.textContent = selected ? `↓ Tải ${selected} ảnh (.zip)` : '↓ Tải ảnh đã chọn (.zip)';
  }
  if (batchDelete) {
    batchDelete.disabled = selected === 0;
    batchDelete.textContent = selected ? `⌫ Xóa ${selected} ảnh` : '⌫ Xóa ảnh đã chọn';
  }
  if (batchMove) batchMove.disabled = selected === 0;
  if (selectAll) selectAll.checked = checkboxes.length > 0 && selected === checkboxes.length;
}
if (selectAll) selectAll.addEventListener('change', () => { checkboxes.forEach((checkbox) => { checkbox.checked = selectAll.checked; }); updateBatchButton(); });
checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateBatchButton));

if (batchDelete) batchDelete.addEventListener('click', (event) => {
  const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
  if (!window.confirm(`Bạn chắc chắn muốn xóa ${selected} ảnh đã chọn? Hành động này không thể hoàn tác.`)) event.preventDefault();
});

const deleteAll = document.querySelector('.delete-all');
if (deleteAll) deleteAll.addEventListener('click', (event) => {
  if (!window.confirm(`Xóa toàn bộ ${checkboxes.length} ảnh trong thư mục hiện tại? Hành động này không thể hoàn tác.`)) event.preventDefault();
});

const photoCards = [...document.querySelectorAll('.photo-card[draggable="true"]')];
const folderTargets = [...document.querySelectorAll('.folder-drop-target[data-folder-id]')];
photoCards.forEach((card) => {
  card.addEventListener('dragstart', (event) => {
    const selectedIds = checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
    const ids = selectedIds.includes(card.dataset.imageId) ? selectedIds : [card.dataset.imageId];
    event.dataTransfer.setData('application/json', JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
});

folderTargets.forEach((folder) => {
  folder.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; folder.classList.add('drag-over'); });
  folder.addEventListener('dragleave', () => folder.classList.remove('drag-over'));
  folder.addEventListener('drop', async (event) => {
    event.preventDefault();
    folder.classList.remove('drag-over');
    let ids;
    try { ids = JSON.parse(event.dataTransfer.getData('application/json')); } catch { return; }
    if (!ids?.length) return;
    const body = new URLSearchParams();
    ids.forEach((id) => body.append('imageIds', id));
    body.set('targetFolderId', folder.dataset.folderId);
    try {
      const response = await fetch('/images/move', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message);
      window.location.reload();
    } catch (error) { window.alert(error.message || 'Không thể di chuyển ảnh.'); }
  });
});

const previews = [...document.querySelectorAll('.photo-preview')];
const lightbox = document.querySelector('#lightbox');
const lightboxImage = document.querySelector('#lightbox-image');
const lightboxName = document.querySelector('#lightbox-name');
const lightboxCount = document.querySelector('#lightbox-count');
const lightboxDownload = document.querySelector('#lightbox-download');
const lightboxLoader = document.querySelector('#lightbox-loader');
const previousButton = document.querySelector('#lightbox-prev');
const nextButton = document.querySelector('#lightbox-next');
const zoomInButton = document.querySelector('#zoom-in');
const zoomOutButton = document.querySelector('#zoom-out');
const zoomLevelButton = document.querySelector('#zoom-level');
const lightboxStage = document.querySelector('.lightbox-stage');
let activeImageIndex = 0;
let zoomLevel = 1;
let fittedImageWidth = 0;
let fittedImageHeight = 0;

function setZoom(nextZoom) {
  zoomLevel = Math.min(4, Math.max(0.5, Math.round(nextZoom * 10) / 10));
  if (zoomLevel > 1 && fittedImageWidth && fittedImageHeight) {
    lightboxImage.style.width = `${Math.round(fittedImageWidth * zoomLevel)}px`;
    lightboxImage.style.height = `${Math.round(fittedImageHeight * zoomLevel)}px`;
    lightboxImage.style.maxWidth = 'none';
    lightboxImage.style.maxHeight = 'none';
    lightboxImage.style.transform = 'scale(1)';
  } else {
    lightboxImage.style.width = '';
    lightboxImage.style.height = '';
    lightboxImage.style.maxWidth = '';
    lightboxImage.style.maxHeight = '';
    lightboxImage.style.transform = `scale(${zoomLevel})`;
  }
  zoomLevelButton.textContent = `${Math.round(zoomLevel * 100)}%`;
  lightboxStage.classList.toggle('is-zoomed', zoomLevel > 1);
  if (zoomLevel === 1) { lightboxStage.scrollTop = 0; lightboxStage.scrollLeft = 0; }
}

function showLightboxImage(index) {
  if (!previews.length) return;
  activeImageIndex = (index + previews.length) % previews.length;
  const preview = previews[activeImageIndex];
  const imageId = preview.dataset.imageId;
  const imageName = preview.dataset.imageName;
  fittedImageWidth = 0;
  fittedImageHeight = 0;
  setZoom(1);
  lightbox.classList.add('loading');
  lightboxLoader.hidden = false;
  lightboxImage.classList.remove('loaded');
  lightboxImage.alt = imageName;
  lightboxName.textContent = imageName;
  lightboxCount.textContent = `${activeImageIndex + 1} / ${previews.length}`;
  lightboxDownload.href = `/images/${imageId}/download`;
  lightboxImage.src = `/images/${imageId}`;
  previousButton.hidden = previews.length < 2;
  nextButton.hidden = previews.length < 2;
}

function openLightbox(index) {
  showLightboxImage(index);
  lightbox.classList.add('open');
  lightbox.setAttribute('aria-hidden', 'false');
  document.body.classList.add('lightbox-open');
}

function closeLightbox() {
  lightbox.classList.remove('open');
  lightbox.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('lightbox-open');
  window.setTimeout(() => { if (!lightbox.classList.contains('open')) lightboxImage.src = ''; }, 250);
}

previews.forEach((preview, index) => preview.addEventListener('click', (event) => { event.preventDefault(); openLightbox(index); }));
lightboxImage?.addEventListener('load', () => {
  lightbox.classList.remove('loading');
  lightboxLoader.hidden = true;
  lightboxImage.classList.add('loaded');
  lightboxImage.style.transform = 'scale(1)';
  fittedImageWidth = lightboxImage.clientWidth;
  fittedImageHeight = lightboxImage.clientHeight;
});
document.querySelectorAll('[data-lightbox-close]').forEach((element) => element.addEventListener('click', closeLightbox));
previousButton?.addEventListener('click', () => showLightboxImage(activeImageIndex - 1));
nextButton?.addEventListener('click', () => showLightboxImage(activeImageIndex + 1));
zoomInButton?.addEventListener('click', () => setZoom(zoomLevel + 0.25));
zoomOutButton?.addEventListener('click', () => setZoom(zoomLevel - 0.25));
zoomLevelButton?.addEventListener('click', () => setZoom(1));
lightboxImage?.addEventListener('dblclick', () => setZoom(zoomLevel === 1 ? 2 : 1));
lightboxStage?.addEventListener('wheel', (event) => {
  if (!lightbox?.classList.contains('open')) return;
  event.preventDefault();
  setZoom(zoomLevel + (event.deltaY < 0 ? 0.25 : -0.25));
}, { passive: false });
document.addEventListener('keydown', (event) => {
  if (!lightbox?.classList.contains('open')) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') showLightboxImage(activeImageIndex - 1);
  if (event.key === 'ArrowRight') showLightboxImage(activeImageIndex + 1);
});
