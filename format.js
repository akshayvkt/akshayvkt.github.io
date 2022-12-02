// function enableDarkMode(event) {
//     var element = document.body;
//     element.classList.toggle("dark");
//         var text = event.textContent || innerText;
//         {
//             if(text == 'Light')
//         {
//             event.innerHTML = 'Dark';
//         }
//             else
//         {
//             event.innerHTML = 'Light';
//         }
//     }
//   }



// Get the button and the body elements
const button = document.querySelector('button');
const body = document.querySelector('body');

// Set a flag to track the current mode (light or dark)
let isDark = body.classList.contains('dark-mode');

// When the button is clicked, toggle the mode and update the page
button.addEventListener('click', () => {
  isDark = !isDark;
  body.classList.toggle('dark-mode', isDark);
  button.innerText = isDark ? 'Light' : 'Dark';
});