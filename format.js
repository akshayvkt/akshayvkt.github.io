function enableDarkMode(event) {
    var element = document.body;
    element.classList.toggle("dark");
        var text = event.textContent || innerText;
        {
            if(text == 'Light')
        {
            event.innerHTML = 'Dark';
        }
            else
        {
            event.innerHTML = 'Light';
        }
    }
  }

// function toggleText(event)
// {
//     var text = event.textContent || event.innerText;
//     if(text == 'Dark')
//     {
//         event.innerHTML = 'Light';
//     }
//     else
//     {
//         event.innerHTML = 'Dark';
//     }
// }