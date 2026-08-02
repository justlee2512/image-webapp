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
    data.append('images', file, file.name);
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
  const maxFiles = Number(input.dataset.maxFiles || 20);
  if (files.length > maxFiles) {
    window.alert(`Mỗi lần chỉ được chọn tối đa ${maxFiles} ảnh.`);
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
function updateBatchButton() {
  const selected = checkboxes.filter((checkbox) => checkbox.checked).length;
  if (batchDownload) {
    batchDownload.disabled = selected === 0;
    batchDownload.textContent = selected ? `↓ Tải ${selected} ảnh (.zip)` : '↓ Tải ảnh đã chọn (.zip)';
  }
  if (selectAll) selectAll.checked = checkboxes.length > 0 && selected === checkboxes.length;
}
if (selectAll) selectAll.addEventListener('change', () => { checkboxes.forEach((checkbox) => { checkbox.checked = selectAll.checked; }); updateBatchButton(); });
checkboxes.forEach((checkbox) => checkbox.addEventListener('change', updateBatchButton));
