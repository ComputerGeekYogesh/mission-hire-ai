const ctx = document.getElementById('barChart').getContext('2d');

new Chart(ctx, {
  type: 'bar',
  data: {
    labels: ['Users', 'Sales', 'Profit'],
    datasets: [{
      label: 'Stats Overview',
      data: [150, 350, 120],
      backgroundColor: ['#0d6efd', '#198754', '#ffc107']
    }]
  },
  options: {
    responsive: true,
    plugins: {
      legend: { display: false },
      title: { display: true, text: 'Summary Chart' }
    }
  }
});
