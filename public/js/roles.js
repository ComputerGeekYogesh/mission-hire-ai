document.getElementById('savePermissions').addEventListener('click', async () => {
  const groupedPermissions = {};

  document.querySelectorAll('.perm-checkbox').forEach(cb => {
    const roleId = cb.dataset.roleId;
    const permKey = cb.dataset.permKey;
    if (!groupedPermissions[roleId]) groupedPermissions[roleId] = [];
    if (cb.checked) groupedPermissions[roleId].push(permKey);
  });

  for (const [roleId, permissions] of Object.entries(groupedPermissions)) {
    const response = await fetch('/admin/roles/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId, permissions })
    });

    const data = await response.json();
    if (data.success) {
      console.log(`Permissions updated for role ${roleId}`);
    } else {
      console.error(data.message);
    }
  }

  alert('All permissions updated successfully!');
});
