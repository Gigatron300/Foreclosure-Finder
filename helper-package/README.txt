COURT DOCS HELPER
=================

What it does
------------
On the Foreclosure Finder site you tick properties on the Camden Pipeline page and press
"Pull court docs". This helper, running on your computer, then downloads each case's court
filings from NJ Courts and saves them in that property's folder inside the shared PROPERTIES
folder on OneDrive.


Before you start (one time)
---------------------------
1. Google Chrome must be installed.

2. The shared PROPERTIES folder must be on this computer:
   a. Open the sharing link you were sent, in OneDrive on the web.
   b. Add the folder to your own OneDrive. The button is called "Add shortcut to My files"
      or "Add to my OneDrive", depending on the account.
   c. Sign in to the OneDrive app on this computer (the cloud icon near the clock).
      After a minute the PROPERTIES folder appears inside your OneDrive folder in File Explorer.

3. You need your own NJ Courts login (portal.njcourts.gov).


Setup (one time)
----------------
1. Unzip this folder somewhere it can stay, for example Documents. Do not run it from
   inside the zip.
2. Double-click "Setup".
   - If Windows shows a blue "Windows protected your PC" box, click "More info",
     then "Run anyway".
   - If it says Node.js was installed, close the window and double-click Setup again.
3. When the folder window opens, choose the PROPERTIES folder from step 2 above.
4. Setup puts a "Court Docs Helper" shortcut on your desktop.


Each time you use it
--------------------
1. Double-click "Court Docs Helper" on the desktop. A black window opens. Leave it open.
2. On the Foreclosure Finder site, open Camden Pipeline, tick "Pull court docs" on the
   cards you want, and press the gold "Pull court docs" button at the bottom.
3. The first time each day a Chrome window opens on NJ Courts. Log in there. The download
   starts by itself once you are in.
4. The bar on the site shows each property finishing. The files are in
   PROPERTIES \ <property address> \ Court Docs F-...  and sync to OneDrive on their own.


If something goes wrong
-----------------------
"The Court Docs Helper is not running on this computer"
    Start it from the desktop shortcut and press the button again. If Chrome asks whether
    the site may connect to devices on your local network, choose Allow.

"PROPERTIES folder not found" in the black window
    The folder was moved or OneDrive is signed out. Run Setup again and choose the folder.

A property shows a red message
    Press the button again for that property. It only fetches what is missing.

To change the folder later, run Setup again.
